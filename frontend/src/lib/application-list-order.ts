import type { ApplicationDetailsStatus } from '@/lib/status';

/**
 * Puts the applications WAITING ON THE WORKER at the top of the list.
 *
 * `GET /worker/applications` answers in `applied_at DESC`, which is the right
 * order for browsing a history and the wrong one for acting: a details request
 * on an application made two months ago lands at the bottom of the list, below
 * the fold, where the one row that needs the worker's hands is the hardest one
 * to reach. Recency is not urgency.
 *
 * The re-order happens on the CLIENT rather than in the query because the API
 * order is still the second key: within each of the two groups this preserves
 * `applied_at DESC` exactly, so the list a worker already knows how to read is
 * unchanged apart from the rows that were lifted out of it.
 *
 * Read off `details_status` -- the TIMESTAMP-derived field -- never off
 * `status`, for the same reason the banners are: an employer who moves a
 * `details_requested` applicant along to `talking` has not stopped waiting on
 * the details, and the row must not sink back into the pile (B4.0 #7).
 */

/** 0 sorts first. Only `requested` is a claim on the worker's time -- `complete`,
 *  `not_requested` and an absent field (a backend that predates 091) are not. */
function waitingRank(row: { details_status?: ApplicationDetailsStatus }): 0 | 1 {
  return row.details_status === 'requested' ? 0 : 1;
}

export function orderApplicationsForList<T extends { details_status?: ApplicationDetailsStatus }>(
  list: readonly T[],
): T[] {
  // Copied before sorting: the caller hands us `usePageData`'s `data`, and
  // `Array.prototype.sort` sorts IN PLACE -- reordering React's own state
  // object behind its back. The comparator returns 0 for two same-group rows
  // and `sort` is required to be stable, which is what keeps `applied_at DESC`
  // intact inside each group.
  return [...list].sort((a, b) => waitingRank(a) - waitingRank(b));
}
