'use client';

import { useRef, useState, type ReactNode } from 'react';
import { adminFetchJson } from '@/lib/admin-fetch';
import type { InboxActionResult } from '@/lib/server/inbox-actions';
import { InboxActionsContext } from './inbox-actions-context';
import { toRunResult } from './inbox-run-result';
import {
  actionKey,
  chooseRequestId,
  isUnknownOutcome,
  withRequestId,
  type InboxActionInput,
  type InboxActionName,
  type InboxRunResult,
} from './inbox-view';

/** Sends the Inbox actions of one page to POST /api/inbox-actions (K2.7), one at a time. */
export function InboxActionsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<InboxActionName | null>(null);
  const inFlight = useRef(false);
  // The id of an attempt whose outcome is unknown (the answer may have been lost
  // after the server committed). The server is idempotent by requestId, so the
  // same action is retried under the same id; anything else gets a new one.
  const retry = useRef<{ key: string; requestId: string } | null>(null);

  async function run(input: InboxActionInput): Promise<InboxRunResult> {
    if (inFlight.current) return { ok: false, error: 'busy' };
    inFlight.current = true;
    setPending(input.action);
    try {
      const key = actionKey(input);
      const requestId = chooseRequestId(retry.current, key, () => crypto.randomUUID());
      // adminFetchJson hashes the body for x-amz-content-sha256 and sends an
      // expired session to sign-in.
      const outcome = await adminFetchJson<InboxActionResult>('/api/inbox-actions', {
        method: 'POST',
        body: withRequestId(input, requestId),
      });
      const result = toRunResult(outcome);
      retry.current = isUnknownOutcome(result) ? { key, requestId } : null;
      return result;
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  return <InboxActionsContext value={{ pending, run }}>{children}</InboxActionsContext>;
}
