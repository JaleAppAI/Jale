// The Security page's search, around the access history's own helpers
// (lib/access-history.ts): the tabs and the filter each one presets (K1.6),
// the Range presets, and the Admin filter's options. Plain functions, used by
// the server view and the browser's search form alike; checked in
// scripts/check-ui-security-view.mjs.
import { accessHistoryHref, type AccessHistoryFilter } from '@/lib/access-history';
import { isoToLocalInput } from '@/lib/local-time';
import type { AdminsPageResult } from '@/lib/server/admin-users';

// --- Tabs ----------------------------------------------------------------------

export type SecurityTab = 'access' | 'actions' | 'sign-ins';
type TabPreset = Pick<AccessHistoryFilter, 'category' | 'outcome'>;

export const SECURITY_TABS: readonly { id: SecurityTab; label: string; preset: TabPreset }[] = [
  { id: 'access', label: 'Access history', preset: {} },
  { id: 'actions', label: 'Admin actions', preset: { outcome: 'done' } },
  { id: 'sign-ins', label: 'Sign-ins', preset: { category: 'admin_access' } },
];

/** The tab whose preset is exactly the search's category and outcome. */
export function activeSecurityTab(filter: AccessHistoryFilter): SecurityTab {
  if (filter.category === 'admin_access' && !filter.outcome) return 'sign-ins';
  if (filter.outcome === 'done' && !filter.category) return 'actions';
  return 'access';
}

export type SecurityTabItem = { label: string; href: string; active: boolean };

function withoutPreset(filter: AccessHistoryFilter): AccessHistoryFilter {
  const { category: _category, outcome: _outcome, ...rest } = filter;
  return rest;
}

/** Each tab keeps the other filters, sets its own preset, and starts at the newest page. */
export function securityTabItems(filter: AccessHistoryFilter): SecurityTabItem[] {
  const active = activeSecurityTab(filter);
  const rest = withoutPreset(filter);
  return SECURITY_TABS.map((tab) => ({
    label: tab.label,
    href: accessHistoryHref({ ...rest, ...tab.preset }),
    active: tab.id === active,
  }));
}

/** "Clear filters": the current tab with nothing else. */
export function securityClearHref(filter: AccessHistoryFilter): string {
  const active = activeSecurityTab(filter);
  const tab = SECURITY_TABS.find((candidate) => candidate.id === active) ?? SECURITY_TABS[0];
  return accessHistoryHref({ ...tab.preset });
}

// --- Range ---------------------------------------------------------------------

export type RangeId = '7d' | '30d';
export type RangeOption = { id: RangeId; label: string; from: string };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** A preset's From still reads as that preset this long after it was made (paging later). */
export const RANGE_MATCH_TOLERANCE_MS = 60 * MINUTE_MS;

/**
 * Last 7 and 30 days, counted back from the server render's time (K1.6), to
 * the whole minute: a datetime-local field holds minutes, so the browser can
 * carry the instant exactly.
 */
export function rangeOptions(nowIso: string): RangeOption[] {
  const minute = Math.floor(Date.parse(nowIso) / MINUTE_MS) * MINUTE_MS;
  return [
    { id: '7d', label: 'Last 7 days', from: new Date(minute - 7 * DAY_MS).toISOString() },
    { id: '30d', label: 'Last 30 days', from: new Date(minute - 30 * DAY_MS).toISOString() },
  ];
}

/** What the Range select shows for a search's From: a preset, 'custom', or '' for none. */
export function rangeSelection(from: string | undefined, ranges: readonly RangeOption[]): RangeId | 'custom' | '' {
  if (!from) return '';
  const at = Date.parse(from);
  if (Number.isNaN(at)) return 'custom';
  const match = ranges.find((range) => Math.abs(Date.parse(range.from) - at) <= RANGE_MATCH_TOLERANCE_MS);
  return match ? match.id : 'custom';
}

/**
 * The form's fields as accessHistorySearchHref reads them. A From typed under
 * "More filters" wins; otherwise a chosen Range becomes the From, in this
 * browser's zone (accessHistorySearchHref turns it back into the same instant).
 */
export function securitySearchFields(
  fields: Readonly<Record<string, unknown>>,
  ranges: readonly RangeOption[],
): Record<string, unknown> {
  const text = (name: string) => {
    const value = fields[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  const { range: _range, ...rest } = fields;
  if (text('fromLocal')) return rest;
  const chosen = ranges.find((option) => option.id === text('range'));
  return chosen ? { ...rest, fromLocal: isoToLocalInput(chosen.from) } : rest;
}

// --- The Admin filter --------------------------------------------------------------

export type SecurityAdminOption = { id: string; email: string };

/** "Everyone" and each admin by email; an actor not on the list is kept so the search shows it. */
export function actorOptions(
  admins: readonly SecurityAdminOption[],
  current: string | undefined,
): { options: { value: string; label: string }[]; selected: string } {
  const options = [{ value: '', label: 'Everyone' }, ...admins.map((admin) => ({ value: admin.id, label: admin.email }))];
  const wanted = (current ?? '').trim();
  if (!wanted) return { options, selected: '' };
  const known = admins.find((admin) => admin.id === wanted.toLowerCase());
  if (known) return { options, selected: known.id };
  return { options: [...options, { value: wanted, label: wanted }], selected: wanted };
}

/** The Admins list as filter options, by email; nothing when the list was refused. */
export function adminFilterOptions(result: AdminsPageResult): SecurityAdminOption[] {
  if (result.status !== 'ok') return [];
  return result.admins
    .map(({ id, email }) => ({ id, email }))
    .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}
