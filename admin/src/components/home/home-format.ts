import { formatCount } from '@/lib/analytics-format';
import { durationText } from '@/lib/local-time';
import type { HomeMetrics } from '@/lib/server/admin-analytics';
import type { ActivityItem, InboxCounts } from '@/lib/server/admin-inbox';

/** Home's section headings (prototype "Main"). */
export const SECTION_HEADING = 'text-[13px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]';

/** A settled read's value, or null when it failed (that section shows its own error). */
export function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

/** "3 new" for the header; null (hidden) on a first visit or when nothing is new. */
export function newSinceText(n: number | null): string | null {
  return n !== null && Number.isFinite(n) && n > 0 ? `${formatCount(n)} new` : null;
}

export type NeedsActionCard = {
  key: 'support' | 'reports' | 'lockouts' | 'delivery';
  title: 'Support conversations' | 'Problem reports' | 'Verification lockouts' | 'Delivery issues';
  href: string;
  count: number;
  /** "2 unread" on the support card. */
  tag: string | null;
  /** Nothing waiting: "All clear". */
  clear: boolean;
  /** "Oldest waiting <3h 12m>", "Oldest new <1d 4h>", "Locked <25m> ago". */
  detail: { lead: string; value: string; tail: string } | null;
};

function waitedFor(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : durationText(nowMs - at);
}

function detailFor(count: number, lead: string, iso: string | null, nowMs: number, tail = ''): NeedsActionCard['detail'] {
  const value = count > 0 ? waitedFor(iso, nowMs) : null;
  return value ? { lead, value, tail } : null;
}

/** The four "Needs action" cards (K2.1), each opening its Inbox tab. */
export function needsActionCards(counts: InboxCounts, nowMs: number): NeedsActionCard[] {
  return [
    {
      key: 'support',
      title: 'Support conversations',
      href: '/inbox?tab=support',
      count: counts.support,
      tag: counts.unreadSupport > 0 ? `${formatCount(counts.unreadSupport)} unread` : null,
      clear: counts.support === 0,
      detail: detailFor(counts.support, 'Oldest waiting', counts.oldestWaiting.support, nowMs),
    },
    {
      key: 'reports',
      title: 'Problem reports',
      href: '/inbox?tab=reports',
      count: counts.reports,
      tag: null,
      clear: counts.reports === 0,
      detail: detailFor(counts.reports, 'Oldest new', counts.oldestWaiting.reports, nowMs),
    },
    {
      key: 'lockouts',
      title: 'Verification lockouts',
      href: '/inbox?tab=lockouts',
      count: counts.lockouts,
      tag: null,
      clear: counts.lockouts === 0,
      detail: detailFor(counts.lockouts, 'Locked', counts.oldestWaiting.lockouts, nowMs, ' ago'),
    },
    {
      // K2.3 has no delivery tab; delivery issues are cases in the All tab (CCR-7).
      key: 'delivery',
      title: 'Delivery issues',
      href: '/inbox?tab=all',
      count: counts.deliveryIssues,
      tag: null,
      clear: counts.deliveryIssues === 0,
      detail: null,
    },
  ];
}

export type KeyMetricTile = { label: string; value: string; hint: string; tone: 'positive' | 'neutral' | 'warning' };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The four KPI tiles (K3.4), in the prototype's words. */
export function keyMetricTiles(m: HomeMetrics): KeyMetricTile[] {
  return [
    {
      label: 'Signups, all time',
      value: formatCount(m.signupsTotal),
      hint: `+${formatCount(m.signupsThisWeek)} this week so far`,
      tone: m.signupsThisWeek > 0 ? 'positive' : 'neutral',
    },
    {
      label: 'Paying employers',
      value: formatCount(m.payingEmployers),
      hint: `+${formatCount(m.payingThisWeek)} this week`,
      tone: m.payingThisWeek > 0 ? 'positive' : 'neutral',
    },
    {
      label: 'Hires, last 30 days',
      value: formatCount(m.hiresLast30d),
      hint: `${formatCount(m.jobsWithHireLast30d)} ${plural(m.jobsWithHireLast30d, 'job', 'jobs')} with a hire`,
      tone: 'neutral',
    },
    {
      label: 'Open jobs',
      value: formatCount(m.openJobs),
      hint: `${formatCount(m.staleJobs14d)} stale`,
      tone: m.staleJobs14d > 0 ? 'warning' : 'neutral',
    },
  ];
}

export type ActivityTone = 'info' | 'warning' | 'success';

const ACTIVITY_TONES: Record<ActivityItem['kind'], ActivityTone> = {
  support_message: 'info',
  support_media: 'info',
  case_opened: 'info',
  report: 'info',
  lockout: 'warning',
  case_resolved: 'success',
  job_resumed: 'success',
};

export function activityTone(kind: ActivityItem['kind']): ActivityTone {
  return ACTIVITY_TONES[kind];
}

/** Server-built activity links must stay inside the console; anything else renders as text. */
export function isInAppPath(href: string | null): href is string {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\');
}
