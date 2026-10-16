// Test-only Home data for check-ui-home.mjs (prototype "Main" numbers). Times
// are relative to `nowMs`, with a few seconds of slack, so durations and
// relative times are stable. STUB is what the step-0 stubs return.
const M = 60_000;
const H = 60 * M;
const D = 24 * H;

export function homeData(nowMs) {
  const ago = (ms) => new Date(nowMs - ms).toISOString();
  const week = (weekStart, cumulative, partial = false) => ({ weekStart, partial, cumulative });
  return {
    counts: {
      waitingOnUs: 7, support: 4, reports: 2, lockouts: 1, deliveryIssues: 0, unreadSupport: 2,
      oldestWaiting: { support: ago(3 * H + 12 * M + 5_000), reports: ago(D + 4 * H + 5_000), lockouts: ago(25 * M + 5_000) },
      newSinceLastVisit: 3,
    },
    metrics: {
      signupsTotal: 1240, signupsThisWeek: 144, payingEmployers: 18, payingThisWeek: 2,
      hiresLast30d: 26, jobsWithHireLast30d: 19, openJobs: 41, staleJobs14d: 6,
      signupsWeekly: [
        week('2026-08-24T00:00:00.000Z', 340), week('2026-08-31T00:00:00.000Z', 412),
        week('2026-09-07T00:00:00.000Z', 486), week('2026-09-14T00:00:00.000Z', 590),
        week('2026-09-21T00:00:00.000Z', 678), week('2026-09-28T00:00:00.000Z', 801),
        week('2026-10-05T00:00:00.000Z', 930), week('2026-10-12T00:00:00.000Z', 1240, true),
      ],
    },
    health: {
      windowLabel: 'last 24 hours',
      items: [
        { key: 'whatsapp_delivery', label: 'WhatsApp delivery', value: '0 failed sends', state: 'healthy' },
        { key: 'message_backlog', label: 'Message backlog', value: '0 stuck · 0 queued over 1 h · 0 dead-lettered', state: 'healthy' },
        { key: 'billing_webhooks', label: 'Billing webhooks', value: '2 failed events', state: 'problem' },
        { key: 'email_bounces', label: 'Email bounces', value: '1 bounce', state: 'watch' },
        { key: 'ai_extraction', label: 'AI extraction', value: 'unavailable', state: 'unknown' },
      ],
    },
    activity: [
      { id: 'a1', at: ago(4 * M + 10_000), kind: 'support_media', text: 'A worker sent a photo in support case S-124', href: '/inbox/support/00000000-0000-4000-8000-000000000124' },
      { id: 'a2', at: ago(25 * M + 10_000), kind: 'lockout', text: 'A worker was locked out after 3 verification attempts', href: '/inbox/lockouts/00000000-0000-4000-8000-0000000000b1' },
      { id: 'a3', at: ago(H + 10_000), kind: 'report', text: 'New problem report R-77', href: '/inbox/reports/00000000-0000-4000-8000-0000000000c1' },
      { id: 'a4', at: ago(2 * H + 10_000), kind: 'case_resolved', text: 'Ops admin resolved support case S-118', href: null },
      { id: 'a5', at: ago(3 * H + 10_000), kind: 'job_resumed', text: "A paused job reopened after its employer's payment went through", href: 'https://example.test/outside' },
    ],
  };
}

export const STUB = {
  counts: null,
  metrics: {
    signupsTotal: 0, signupsThisWeek: 0, payingEmployers: 0, payingThisWeek: 0,
    hiresLast30d: 0, jobsWithHireLast30d: 0, openJobs: 0, staleJobs14d: 0, signupsWeekly: [],
  },
  health: { items: [], windowLabel: 'last 24 hours' },
  activity: [],
};
