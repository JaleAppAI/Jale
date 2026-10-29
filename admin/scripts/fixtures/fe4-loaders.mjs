// Test-only stand-in for src/lib/server/admin-analytics.ts, used by the FE-4
// fixture gallery (scripts/fixtures/fe4-gallery.mjs) through compileAdminSources
// fakes. Never imported by src/. Every loader returns synthetic data shaped
// exactly like K3: globalThis.__adminCheck.fe4Mode picks 'long' (26 rich weeks)
// or 'empty' (what step 0's stubs return). Parsers mirror the real ones.
const DAY = 86_400_000;
const mode = () => globalThis.__adminCheck?.fe4Mode ?? 'long';
const calls = () => (globalThis.__adminCheck.fe4Calls ??= { inFlight: 0, max: 0, names: [] });

// Every loader resolves on a later tick, so the gallery can measure how many
// run at once (the pages promise at most three).
function loader(name, make) {
  return async (...args) => {
    const c = calls();
    c.names.push(name);
    c.inFlight += 1;
    c.max = Math.max(c.max, c.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    c.inFlight -= 1;
    return make(...args);
  };
}

function weekStarts(count, now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monday = day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY;
  return Array.from({ length: count }, (_, i) => new Date(monday - (count - 1 - i) * 7 * DAY).toISOString());
}
const wave = (i, base, swing) => Math.max(0, Math.round(base + swing * Math.sin(i * 1.3) + i * (swing / 8)));
const long = () => mode() === 'long';
const ORG_ROOFING = '00000000-0000-4000-8000-0000000000a1';
const ORG_LONG = '00000000-0000-4000-8000-0000000000a2';
const ORG_PLUMBING = '00000000-0000-4000-8000-0000000000a3';
const ORG_FREE = '00000000-0000-4000-8000-0000000000a4';
const ORG_OVER = '00000000-0000-4000-8000-0000000000a5';

export const DEFAULT_ANALYTICS_RANGE = '30d';
export const DEFAULT_FUNNEL_WEEKS = 8;
export const FUNNEL_STALLED_DAYS = 7;
export const STALE_JOB_DAYS = 14;
export const parseFunnelWeeks = (v) => (v === '13' ? 13 : v === '26' ? 26 : 8);
export const parseFunnelDoor = (v) => (v === 'whatsapp' || v === 'web' ? v : 'all');
export const parseSignupsView = (v) => (v === 'new' ? 'new' : 'total');
export const parseStaleDays = (v) => (v === '7' ? 7 : v === '30' ? 30 : 14);

export const getAnalyticsTotals = loader('getAnalyticsTotals', () =>
  long()
    ? { totalWorkers: 1050, totalEmployers: 190, payingEmployers: 18, jobsActive: 64, jobsPaused: 5, jobsFilled: 3, jobsClosed: 40, hiresTotal: 26, jobsWithHire: 19, totalVerifiedWorkers: 980 }
    : { totalWorkers: 0, totalEmployers: 0, payingEmployers: 0, jobsActive: 0, jobsPaused: 0, jobsFilled: 0, jobsClosed: 0, hiresTotal: 0, jobsWithHire: 0, totalVerifiedWorkers: 0 });
export const getSignups = loader('getSignups', (weeks) =>
  weekStarts(typeof weeks === 'number' ? weeks : 8).map((bucketStart, i) => ({
    bucketStart,
    workerSignups: long() ? wave(i, 40, 25) : 0,
    employerSignups: long() ? wave(i, 6, 4) : 0,
    workerSignupsVerified: long() ? wave(i, 36, 22) : 0,
  })));
export const getJobsActivity = loader('getJobsActivity', (weeks) =>
  weekStarts(typeof weeks === 'number' ? weeks : 8).map((bucketStart, i) => ({
    bucketStart,
    jobsPosted: long() ? wave(i, 9, 7) : 0,
    applicationsSubmitted: long() ? wave(i, 120, 90) : 0,
  })));
export const getMessageTraffic = loader('getMessageTraffic', (weeks) =>
  weekStarts(typeof weeks === 'number' ? weeks : 8).map((bucketStart, i) => ({
    bucketStart, jobMessagesOut: long() ? 40 + i : 0, jobMessagesIn: long() ? 30 : 0, jobMessagesFailed: long() && i % 5 === 0 ? 1 : 0,
    waInbound: long() ? 300 : 0, waOutbound: long() ? 320 : 0, waFailed: long() && i % 4 === 0 ? 2 : 0,
  })));
export const loadPayingEmployers = loader('loadPayingEmployers', () =>
  long()
    ? [
        { employerId: '00000000-0000-4000-8000-000000000e01', displayName: 'Example Roofing Co', planCode: 'starter', status: 'active', currentPeriodEnd: '2026-11-01T00:00:00.000Z', cancelAtPeriodEnd: false, organizationId: ORG_ROOFING, membersActive: 4, seatsUsed: 2, seatsPending: 1, seatsSuspended: 1, seatLimit: 3 },
        { employerId: '00000000-0000-4000-8000-000000000e02', displayName: 'A very long example employer name that wraps on phones', planCode: 'pro', status: 'past_due', currentPeriodEnd: '2026-10-20T00:00:00.000Z', cancelAtPeriodEnd: true, organizationId: ORG_LONG, membersActive: 1, seatsUsed: 0, seatsPending: 0, seatsSuspended: 0, seatLimit: null },
        // An unnamed company: the label adds the first four characters of the id.
        { employerId: '3fa10000-0000-4000-8000-000000000e08', displayName: 'Empleador', planCode: 'pro', status: 'trialing', currentPeriodEnd: '2026-11-05T00:00:00.000Z', cancelAtPeriodEnd: false, organizationId: ORG_FREE, membersActive: 1, seatsUsed: 0, seatsPending: 0, seatsSuspended: 0, seatLimit: 3 },
      ]
    : []);
export const getPayingWeekly = loader('getPayingWeekly', (weeks) => {
  const starts = weekStarts(weeks);
  return {
    weeks: starts.map((weekStart, i) => ({ weekStart, partial: i === starts.length - 1, employers: long() ? 150 + i * 2 : 0, paying: long() ? 10 + Math.floor(i / 3) : 0, newPaying: long() ? wave(i, 2, 2) : 0, churned: long() && i % 6 === 0 ? 1 : 0 })),
    approximateBefore: long() ? starts[3] : null,
  };
});
export const getDigestAdoption = loader('getDigestAdoption', () => (long() ? { employers: 190, digestOn: 120, digestOnWithEmail: 117 } : { employers: 0, digestOn: 0, digestOnWithEmail: 0 }));
export const getDigestSends = loader('getDigestSends', (weeks) => {
  const rows = weekStarts(weeks).map((weekStart, i) => ({ weekStart, emailed: long() ? wave(i, 60, 30) : 0, sent: long() ? wave(i, 58, 30) : 0, failed: 0, unknown: 0, inProgress: 0, employersReached: long() ? 40 : 0 }));
  return [...rows, { weekStart: null, emailed: rows.reduce((s, r) => s + r.emailed, 0), sent: rows.reduce((s, r) => s + r.sent, 0), failed: 0, unknown: 0, inProgress: 0, employersReached: long() ? 90 : 0 }];
});
export const getAcquisition = loader('getAcquisition', (weeks) => {
  if (!long()) return { weeks: [], collectingSince: null };
  const starts = weekStarts(weeks);
  return {
    weeks: starts.map((weekStart, i) => {
      const bySource = { shared_link: wave(i, 8, 6), campaign_tag: wave(i + 2, 3, 3), referral: wave(i + 1, 5, 4), direct: wave(i, 12, 5), whatsapp_entry: wave(i + 3, 20, 10), unknown: i % 7 === 0 ? 1 : 0 };
      return { weekStart, partial: i === starts.length - 1, bySource, total: Object.values(bySource).reduce((a, b) => a + b, 0) };
    }),
    collectingSince: starts[0],
  };
});

export const getOnboardingCohorts = loader('getOnboardingCohorts', (weeks) =>
  long()
    ? weekStarts(weeks).flatMap((cohortWeek, i) => [
        { cohortWeek, door: 'whatsapp', started: wave(i, 40, 15), codeRequested: wave(i, 36, 14), verified: wave(i, 28, 10), acceptedTerms: wave(i, 25, 9), finishedProfile: wave(i, 20, 8), ready: wave(i, 18, 7), declined: 1, inProgress: 3, abandoned: 4 },
        { cohortWeek, door: 'web', started: wave(i, 10, 5), codeRequested: wave(i, 10, 5), verified: wave(i, 9, 4), acceptedTerms: wave(i, 8, 4), finishedProfile: wave(i, 6, 3), ready: wave(i, 5, 3), declined: 0, inProgress: 1, abandoned: 1 },
      ])
    : []);
export const getOnboardingStalled = loader('getOnboardingStalled', () =>
  long() ? [{ door: 'whatsapp', stepKey: 'identity.verify_otp', workers: 7 }, { door: 'web', stepKey: 'profile.voice_choice', workers: 3 }, { door: 'other', stepKey: 'legal.review', workers: 1 }] : []);
export const getOnboardingSteps = loader('getOnboardingSteps', () =>
  long()
    ? {
        started: 1000,
        steps: [
          ['start.choose_language', 'Language', 940, false], ['identity.verify_otp', 'Phone code', 700, false], ['legal.review', 'Terms', 660, false],
          ['profile.voice_choice', 'Voice note', 600, false], ['profile.trade', 'Trade', 560, false], ['profile.custom_trade', 'Custom trade', 40, true],
          ['profile.experience', 'Experience', 520, false], ['profile.photo', 'Photo', 410, false],
        ].map(([stepKey, label, reached, branch], i) => ({ stepKey, label, order: i + 1, branch, reached, ofStarted: reached / 10, ofPrevious: null })),
      }
    : { started: 0, steps: [] });
export const getIdentityFunnel = loader('getIdentityFunnel', () =>
  long()
    ? { challenges: 500, reachedCode: 480, verified: 320, lockedOnce: 12, expiredUnused: 40, attempts: { zero: 300, one: 120, two: 50, threePlus: 30 }, medianMinutesToVerify: 4.2, p75MinutesToVerify: 9, timingsSince: weekStarts(3)[0] }
    : { challenges: 0, reachedCode: 0, verified: 0, lockedOnce: 0, expiredUnused: 0, attempts: { zero: 0, one: 0, two: 0, threePlus: 0 }, medianMinutesToVerify: null, p75MinutesToVerify: null, timingsSince: null });
export const getReferralFunnel = loader('getReferralFunnel', (weeks) => {
  if (!long()) return { weeks: [], snapshotsSince: null };
  const starts = weekStarts(weeks);
  return { weeks: starts.map((weekStart, i) => ({ weekStart, partial: i === starts.length - 1, opens: wave(i, 30, 10), applyIntents: wave(i, 12, 5), claims: wave(i, 6, 3), applications: wave(i, 4, 2), hires: i % 5 === 0 ? 1 : 0 })), snapshotsSince: starts[0] };
});
export const getOnboardingRestarts = loader('getOnboardingRestarts', () => []);
export const getOperatorResets = loader('getOperatorResets', () => []);
export const getJobViewFunnel = loader('getJobViewFunnel', (weeks) => {
  if (!long()) return { weeks: [], collectingSince: null };
  const starts = weekStarts(weeks);
  return { weeks: starts.map((weekStart, i) => ({ weekStart, partial: i === starts.length - 1, publicOpens: wave(i, 200, 80), publicApplications: wave(i, 12, 6), workerViews: wave(i, 400, 100), workerViewApplications: wave(i, 30, 12) })), collectingSince: starts[0] };
});
export const getMatchToApply = loader('getMatchToApply', (weeks) => {
  if (!long()) return { weeks: [], collectingSince: null };
  const starts = weekStarts(weeks);
  return {
    weeks: starts.flatMap((weekStart, i) => [
      { weekStart, partial: i === starts.length - 1, channel: 'web', shown: wave(i, 500, 100), appliedWithin7d: wave(i, 25, 10) },
      { weekStart, partial: i === starts.length - 1, channel: 'whatsapp', shown: wave(i, 300, 80), appliedWithin7d: wave(i, 30, 12) },
    ]),
    collectingSince: starts[0],
  };
});

export const getEmployerWeekly = loader('getEmployerWeekly', (weeks) => {
  const figures = (i) => ({
    applications: long() ? wave(i, 120, 60) : 0, answered: long() ? wave(i, 90, 40) : 0, answeredUntimed: 0, unanswered7d: long() ? 5 : 0, applicationsDue: long() ? 100 : 0,
    firstResponseP50Hours: long() && i % 9 !== 4 ? 6 + (i % 5) * 3.3 : null, firstResponseP75Hours: long() ? 30 : null,
    workerTurns: long() ? 40 : 0, turnsUnanswered7d: long() ? 2 : 0, turnsDue: long() ? 35 : 0,
    replyP50Hours: long() ? 2 + (i % 4) * 1.5 : null, replyP75Hours: long() ? 8 : null,
    hires: long() ? wave(i, 2, 2) : 0, hiresApproximate: 0, timeToHireP50Days: long() ? 4.5 : null, timeToHireP75Days: long() ? 9 : null,
  });
  return [...weekStarts(weeks).map((weekStart, i) => ({ weekStart, activeJobs: null, ...figures(i) })), { weekStart: null, activeJobs: long() ? 64 : 0, ...figures(3) }];
});
export const loadSlowestEmployers = loader('loadSlowestEmployers', () =>
  long()
    ? [
        { employerId: '00000000-0000-4000-8000-000000000e03', displayName: 'Example Plumbing', applications: 14, unanswered7d: 6, firstResponseP50Hours: 72.5, activeJobs: 3, organizationId: ORG_PLUMBING },
        { employerId: '00000000-0000-4000-8000-000000000e05', displayName: 'Memberless Painting', applications: 9, unanswered7d: 2, firstResponseP50Hours: 30, activeJobs: 1, organizationId: null },
      ]
    : []);
// Phase 5: companies. One row per seat-meter case: 2 of 3 with pending and suspended,
// no seats on the plan, over the limit on a plan with none, and an unknown limit.
export const COMPANIES_LIMIT = 100;
const company = (organizationId, ownerId, displayName, seats, extra = {}) => ({
  organizationId, ownerId, displayName, createdAt: '2026-09-01T10:00:00.000Z', planCode: 'employer_pro', planStatus: 'active',
  membersActive: 1 + seats.seatsUsed, seatsUsed: 0, seatsPending: 0, seatsSuspended: 0, seatLimit: 3, activeJobs: 2, ...seats, ...extra,
});
const COMPANY_ROWS = () => [
  company(ORG_ROOFING, '00000000-0000-4000-8000-000000000e01', 'Example Roofing Co', { seatsUsed: 2, seatsPending: 1, seatsSuspended: 1, seatLimit: 3 }),
  company(ORG_FREE, '00000000-0000-4000-8000-000000000e06', 'Free Plan Framing', { seatsUsed: 0, seatLimit: 0 }, { planCode: 'employer_free', planStatus: null }),
  company(ORG_OVER, '00000000-0000-4000-8000-000000000e07', 'Empleador', { seatsUsed: 3, seatLimit: 0 }),
  company(ORG_LONG, '00000000-0000-4000-8000-000000000e02', 'A very long example employer name that wraps on phones', { seatsUsed: 4, seatLimit: null }),
];
export const loadCompanies = loader('loadCompanies', () => {
  if (!long()) return [];
  const rows = COMPANY_ROWS();
  return globalThis.__adminCheck?.fe4CompaniesFull
    ? Array.from({ length: COMPANIES_LIMIT }, (_, i) => ({ ...rows[i % rows.length], organizationId: `00000000-0000-4000-8000-0000000c${String(i).padStart(4, '0')}` }))
    : rows;
});
// globalThis.__adminCheck.fe4Company picks the shape:
//   'found' (default): a company with an active, a suspended-for-billing, a suspended and a removed foreman;
//   'owner-only': a past-due company holding only its owner;  'free': a free-plan company (no plan status, no seats);
//   'empty': a company with no member rows;  'missing': the real loader's not_found shape.
// Like the real loader, an id that is not a uuid is not found.
const OWNER = { userId: '00000000-0000-4000-8000-000000000e01', displayName: 'Example Roofing Co Owner', role: 'owner', status: 'active', billingSuspended: false, joinedAt: '2026-09-01T10:00:00.000Z', statusChangedAt: null, activeJobs: 2 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const loadCompany = loader('loadCompany', (_session, organizationId) => {
  const check = globalThis.__adminCheck;
  check.fe4CompanyLoads = [...(check.fe4CompanyLoads ?? []), organizationId];
  const shape = check.fe4Company ?? 'found';
  if (shape === 'missing' || !UUID.test(organizationId)) return { company: null, members: [] };
  const [base] = COMPANY_ROWS();
  if (shape === 'owner-only') return { company: { ...base, planStatus: 'past_due', seatsUsed: 0, seatsPending: 0, seatsSuspended: 0, membersActive: 1 }, members: [OWNER] };
  if (shape === 'free') return { company: { ...base, planCode: 'employer_free', planStatus: null, seatsUsed: 0, seatsPending: 0, seatsSuspended: 0, seatLimit: 0, membersActive: 1 }, members: [OWNER] };
  if (shape === 'empty') return { company: base, members: [] };
  return {
    company: base,
    members: [
      OWNER,
      { userId: '00000000-0000-4000-8000-000000000f01', displayName: 'Rosa Mendez', role: 'foreman', status: 'active', billingSuspended: false, joinedAt: '2026-09-05T10:00:00.000Z', statusChangedAt: '2026-09-10T10:00:00.000Z', activeJobs: 1 },
      { userId: '00000000-0000-4000-8000-000000000f02', displayName: null, role: 'foreman', status: 'suspended', billingSuspended: true, joinedAt: '2026-09-06T10:00:00.000Z', statusChangedAt: '2026-09-20T10:00:00.000Z', activeJobs: 0 },
      { userId: '00000000-0000-4000-8000-000000000f03', displayName: '   ', role: 'foreman', status: 'removed', billingSuspended: false, joinedAt: '2026-09-07T10:00:00.000Z', statusChangedAt: '2026-09-21T10:00:00.000Z', activeJobs: 0 },
      { userId: '00000000-0000-4000-8000-000000000f04', displayName: 'Luis Ortega', role: 'foreman', status: 'suspended', billingSuspended: false, joinedAt: '2026-09-08T10:00:00.000Z', statusChangedAt: null, activeJobs: 3 },
    ],
  };
});
export const loadStaleJobs = loader('loadStaleJobs', (_session, days) =>
  long()
    ? Array.from({ length: days === 7 ? 30 : 6 }, (_, i) => ({ jobId: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, title: `Example job ${i + 1}`, employerId: '00000000-0000-4000-8000-000000000e04', displayName: 'Example Builders', postedAt: '2026-08-01T00:00:00.000Z', lastEmployerActionAt: i % 2 ? '2026-08-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z', daysIdle: days + i, waitingApplicants: i, lastApplicationAt: i % 3 ? '2026-09-20T00:00:00.000Z' : null }))
    : []);
export const getTemplateReuse = loader('getTemplateReuse', (weeks) => {
  if (!long()) return { weeks: [], collectingSince: null };
  const starts = weekStarts(weeks);
  return { weeks: starts.map((weekStart, i) => ({ weekStart, partial: i === starts.length - 1, jobs: wave(i, 9, 5), fromTemplate: wave(i, 3, 2), employersUsingTemplates: 2, templatesSaved: 5 })), collectingSince: starts[0] };
});

export const getMessageBacklog = loader('getMessageBacklog', () =>
  long() ? [{ lane: 'reply', openUnder1h: 2, open1To24h: 1, open24To48h: 0, stuck: 1, oldestStuckAt: new Date(Date.now() - 3_600_000).toISOString() }] : []);
export const getMessageFailures = loader('getMessageFailures', (weeks) => {
  if (!long()) return [{ weekStart: null, lane: null, created: 0, gaveUp: 0, deliveryFailed: 0 }];
  const lanes = ['reply', 'admin', 'worker_notification', 'employer_invite', 'employer_freeform', 'job_alert'];
  const starts = weekStarts(weeks);
  const rows = starts.flatMap((weekStart, i) => lanes.map((lane, l) => ({ weekStart, lane, created: 50 + l * 10, gaveUp: (i + l) % 4, deliveryFailed: (i * l) % 3 })));
  return [...rows, ...lanes.map((lane) => ({ weekStart: null, lane, created: 500, gaveUp: 20, deliveryFailed: 10 })), { weekStart: null, lane: null, created: 3000, gaveUp: 120, deliveryFailed: 60 }];
});
export const getBillingInboxNow = loader('getBillingInboxNow', () => ({ stuckReceived: long() ? 1 : 0, failedNow: 0, failedLast24h: 0, unresolvedOlder: long() ? 2 : 0, oldestStuckAt: long() ? new Date(Date.now() - 1_200_000).toISOString() : null }));
const VOICE_ZERO = { processed: 0, failed: 0, failedTranscribe: 0, failedEmptyTranscript: 0, failedAudioRead: 0, failedModelCall: 0, failedBadJson: 0, failedBadShape: 0, failedPipelineError: 0, failedUnrecorded: 0, usable: 0, fullNameFound: 0, cityFound: 0, mainTradeFound: 0, mainTradeOtherDue: 0, mainTradeOtherFound: 0, yearsExperienceFound: 0, hasTransportationFound: 0, availabilityFound: 0 };
export const getVoiceExtraction = loader('getVoiceExtraction', (weeks) => {
  if (!long()) return [{ ...VOICE_ZERO, weekStart: null, model: null }];
  const rows = weekStarts(weeks).map((weekStart, i) => ({ ...VOICE_ZERO, weekStart, model: null, processed: 100, usable: 92 + (i % 7), failed: 8 - (i % 7), failedModelCall: 8 - (i % 7), fullNameFound: 80, cityFound: 70, mainTradeFound: 85 }));
  return [...rows, { ...VOICE_ZERO, weekStart: null, model: null, processed: 100 * rows.length, usable: 95 * rows.length, failed: 5 * rows.length, failedModelCall: 5 * rows.length, fullNameFound: 80 * rows.length, cityFound: 70 * rows.length, mainTradeFound: 85 * rows.length }];
});
export const getTrustExtraction = loader('getTrustExtraction', () => [{ weekStart: null, extractorVersion: null, extractions: 0, failed: 0, notEnoughDetail: 0, avgSections: null }]);
export const getBillingInbox = loader('getBillingInbox', () => [{ weekStart: null, eventType: null, received: 0, processed: 0, skipped: 0, failed: 0, retried: 0, paymentFailedInvoices: 0 }]);
export const getCaseAging = loader('getCaseAging', () =>
  long() ? [{ label: '<1h', waitingOnUs: 2, waitingOnWorker: 0 }, { label: '1–4h', waitingOnUs: 3, waitingOnWorker: 1 }, { label: '>3d', waitingOnUs: 1, waitingOnWorker: 2 }] : []);
export const getCaseResolution = loader('getCaseResolution', (weeks) =>
  long() ? weekStarts(weeks).map((weekStart, i, all) => ({ weekStart, partial: i === all.length - 1, resolved: wave(i, 6, 4), medianHours: i % 6 === 2 ? null : 3 + (i % 4), p75Hours: i % 6 === 2 ? null : 9 + (i % 5) })) : []);
export const getResetReasons = loader('getResetReasons', () =>
  long() ? [{ source: 'lockout_reset', reasonLabel: 'Codes not arriving', count: 11 }, { source: 'lockout_reset', reasonLabel: 'Confused by steps', count: 5 }, { source: 'operator_reset', reasonLabel: 'Operator reset', count: 4 }] : []);
export const getDlqDepth = loader('getDlqDepth', () =>
  long()
    ? { queues: [{ label: 'WhatsApp inbound', visible: 0, inFlight: 0, unavailable: false }, { label: 'Billing webhooks', visible: null, inFlight: null, unavailable: true }], totalVisible: 0 }
    : { queues: [], totalVisible: null });
// The real loader always returns the five K3 buckets in this order (zeros when empty).
const RANKING_BUCKETS = [['<1h', 4], ['1–6h', 5], ['6–24h', 2], ['1–3d', 2], ['>3d', 1]];
export const getRankingFreshness = loader('getRankingFreshness', () => ({ buckets: RANKING_BUCKETS.map(([label, jobs]) => ({ label, jobs: long() ? jobs : 0 })), jobsOlderThan24h: long() ? 3 : 0, fallbackShare: null, fallbackJobs: long() ? 1 : 0, rankedJobs: long() ? 12 : 0, jobsWithApplicationsButNoRanking: long() ? 2 : 0 }));
