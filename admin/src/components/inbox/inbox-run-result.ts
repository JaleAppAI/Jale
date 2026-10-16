import type { AdminFetchOutcome } from '@/lib/admin-fetch';
import { isInboxActionResult, type InboxRunResult } from './inbox-view';

/**
 * What adminFetchJson brought back, as the Inbox controls read it. A body
 * counts only when it has the K2.7 shape and matches the status class
 * (success on 2xx, refusal otherwise). Anything else is "unexpected", so a
 * stub, an edge page or a malformed link never opens or navigates anything.
 */
export function toRunResult(outcome: AdminFetchOutcome<unknown>): InboxRunResult {
  if (outcome.kind === 'redirecting') return { ok: false, error: 'redirecting' };
  if (outcome.kind === 'network') return { ok: false, error: 'network' };
  const body = outcome.data;
  if (isInboxActionResult(body) && body.ok === (outcome.kind === 'ok')) return body;
  return { ok: false, error: 'unexpected', status: outcome.status };
}
