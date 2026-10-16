import type { ConversationTarget } from '@/contexts/ConversationDrawerContext';
import type { InboxItem } from '@/lib/api/employer';

/**
 * The applicants the conversation drawer has been asked to open, with the
 * fields the caller passed to DRAW them (see `ConversationTarget`).
 *
 * One slot was not enough: the inbox does not list every applicant the board
 * does, so an off-inbox applicant's only description was the latest request,
 * and opening a second one erased the first -- no list row, and the vanish
 * guard dropped them. A map keyed by application keeps every one of them
 * reachable. Insertion order is recency; the cap keeps a long session from
 * growing the list without bound.
 */
export const DESCRIBED_TARGETS_CAP = 20;

export type DescribedTargets = ReadonlyMap<string, ConversationTarget>;

/** Adds or refreshes one description as the newest; evicts the oldest above the cap. */
export function rememberDescribedTarget(
  prev: DescribedTargets,
  target: ConversationTarget,
  cap: number = DESCRIBED_TARGETS_CAP,
): DescribedTargets {
  const next = new Map(prev);
  next.delete(target.application_id);
  next.set(target.application_id, target);
  while (next.size > cap) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * Drops the descriptions the inbox no longer needs: an application it lists
 * WITH a conversation is drawn from that row from now on (and must be free to
 * vanish if it is later dismissed). Same map back when nothing drops.
 */
export function forgetThreadedTargets(prev: DescribedTargets, items: readonly InboxItem[]): DescribedTargets {
  const threaded = new Set(
    items.filter((entry) => entry.conversation_id !== null).map((entry) => entry.application_id),
  );
  let changed = false;
  const next = new Map<string, ConversationTarget>();
  for (const [key, value] of prev) {
    if (threaded.has(key)) {
      changed = true;
      continue;
    }
    next.set(key, value);
  }
  return changed ? next : prev;
}

/**
 * The "New conversation" rows: descriptions that can be drawn (`job_title` is
 * the gate, as in the drawer's `composerSubjectFor`) and are not already a
 * thread row, newest first.
 */
export function describedRows(targets: DescribedTargets, threads: readonly InboxItem[]): ConversationTarget[] {
  const listed = new Set(threads.map((entry) => entry.application_id));
  return [...targets.values()]
    .filter((entry) => typeof entry.job_title === 'string' && !listed.has(entry.application_id))
    .reverse();
}
