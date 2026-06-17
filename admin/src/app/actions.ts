'use server';

import { revalidatePath } from 'next/cache';
import { formDataToAdminActionRequest } from '@/lib/action-requests';
import { dispatchAdminAction } from '@/lib/server/admin-action-dispatch';
import type { RevealedContact } from '@/lib/server/admin-cases';
import { requireAdminSession } from '@/lib/server/session';

function revalidateAdminRoutes(targetType: string, targetId: string): void {
  revalidatePath('/');
  revalidatePath('/cases');
  revalidatePath('/verifications');
  revalidatePath('/audit');
  revalidatePath(`/${targetType === 'verification' ? 'verifications' : 'cases'}/${targetId}`);
}

export type AdminActionFormState = {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  actionId?: string;
  /**
   * Raw contact returned ONLY for an audited reveal_pii action. Held in
   * ephemeral client state for this render; navigating/refreshing re-masks.
   */
  revealed?: RevealedContact;
};

// Result-returning variant used with useActionState so the detail panel can
// surface a revealed contact inline (and show explicit error messages).
export async function submitAdminActionState(
  _prev: AdminActionFormState,
  formData: FormData,
): Promise<AdminActionFormState> {
  const parsed = formDataToAdminActionRequest(formData);

  if (!parsed.ok) {
    return { status: 'error', message: 'Invalid admin action request.' };
  }

  const session = await requireAdminSession();
  const result = await dispatchAdminAction(session, parsed.value);

  if (!result.ok) {
    return { status: 'error', message: result.message, actionId: parsed.value.actionId };
  }

  revalidateAdminRoutes(parsed.value.targetType, parsed.value.targetId);

  return {
    status: 'ok',
    message: result.message,
    actionId: parsed.value.actionId,
    ...(result.revealed ? { revealed: result.revealed } : {}),
  };
}
