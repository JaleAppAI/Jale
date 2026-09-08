import { describe, expect, it } from 'vitest';
import { orderApplicationsForList } from '@/lib/application-list-order';

/**
 * The applications list arrives ORDER BY applied_at DESC and is re-ordered on
 * the client so the rows waiting on the WORKER sit at the top. Two properties
 * carry the whole feature and both are easy to break by accident:
 *
 *   - the requested rows come first, and
 *   - the API's order survives WITHIN each group.
 *
 * A comparator that returned anything but 0 for two same-group rows would pass
 * a "requested first" assertion while quietly scrambling the dates the rest of
 * the page is ordered by.
 */

type Row = { id: string; details_status?: 'not_requested' | 'requested' | 'complete' };

function rows(...spec: [string, Row['details_status']?][]): Row[] {
  return spec.map(([id, details_status]) => (details_status ? { id, details_status } : { id }));
}

const ids = (list: readonly Row[]) => list.map((r) => r.id);

describe('orderApplicationsForList', () => {
  it('floats a requested row above the rows applied to more recently', () => {
    const list = rows(['newest'], ['middle'], ['oldest', 'requested']);
    expect(ids(orderApplicationsForList(list))).toEqual(['oldest', 'newest', 'middle']);
  });

  it('keeps the API order among the requested rows themselves', () => {
    const list = rows(['a', 'requested'], ['b'], ['c', 'requested']);
    expect(ids(orderApplicationsForList(list))).toEqual(['a', 'c', 'b']);
  });

  it('keeps the API order among the rows that are not requested', () => {
    const list = rows(['a'], ['b'], ['c', 'requested'], ['d'], ['e']);
    expect(ids(orderApplicationsForList(list))).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('leaves a list with nothing requested exactly as it came', () => {
    const list = rows(['a'], ['b', 'complete'], ['c', 'not_requested']);
    expect(ids(orderApplicationsForList(list))).toEqual(['a', 'b', 'c']);
  });

  it('reads ONLY `requested` as waiting on the worker', () => {
    // `complete` and `not_requested` are not a claim on the worker's time, and
    // an absent field (a backend that has not shipped 091 yet) is not either.
    const list = rows(['done', 'complete'], ['absent'], ['waiting', 'requested']);
    expect(ids(orderApplicationsForList(list))).toEqual(['waiting', 'done', 'absent']);
  });

  it('does not mutate the array it was given', () => {
    // The input is `usePageData`'s `data`: sorting it in place would reorder
    // React's own state object behind its back.
    const list = rows(['a'], ['b', 'requested']);
    const before = ids(list);
    orderApplicationsForList(list);
    expect(ids(list)).toEqual(before);
  });

  it('returns a new array even when nothing moves', () => {
    const list = rows(['a'], ['b']);
    expect(orderApplicationsForList(list)).not.toBe(list);
  });

  it('handles an empty list', () => {
    expect(orderApplicationsForList([])).toEqual([]);
  });
});
