import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const nav = read('src/components/AdminNav.tsx');
const actions = read('src/components/AdminActionsPanel.tsx');
const login = read('src/components/AdminLoginForm.tsx');
const css = read('src/app/globals.css');

assert.match(
  nav,
  /isLoggedIn\s*\?\s*\(\s*<>[\s\S]*NAV_LINKS\.map/,
  'protected admin navigation should render only for authenticated admins',
);
assert.match(
  actions,
  /pendingActionId/,
  'action loading state should track the submitted action',
);
assert.doesNotMatch(
  actions,
  /\{isPending\s*\?\s*'Processing/,
  'all action buttons must not display the same loading label',
);
// The panel calls the server action as a plain RPC from a click handler instead
// of going through useActionState. That is deliberate and survives the React 19
// upgrade (rewiring it is follow-up F34), but the comment explaining it must not
// go on claiming the app runs React 18.
assert.doesNotMatch(
  actions,
  /React 18/,
  'the manual-RPC comment must not still claim React 18 -- the app is on React 19',
);
assert.match(
  actions,
  /F34/,
  'the manual RPC must point at the follow-up that revisits it (F34)',
);
assert.match(
  login,
  /className="button secondary"/,
  'the MFA back button should use the shared secondary button treatment',
);
assert.match(
  login,
  /newPasswordRequired/,
  'admin-created Cognito users should be able to replace their temporary password',
);
assert.match(
  login,
  /mfaSetup/,
  'admins should be able to enroll a software token when Cognito requires MFA setup',
);
assert.match(
  css,
  /\.nav a:focus-visible,[\s\S]*\.button:focus-visible/,
  'navigation and buttons should expose a visible keyboard focus state',
);

const trend = read('src/components/analytics/TrendChart.tsx');
const column = read('src/components/analytics/ColumnChart.tsx');

assert.doesNotMatch(trend, /'use client'/, 'TrendChart stays a server component');
assert.doesNotMatch(column, /'use client'/, 'ColumnChart stays a server component');
assert.match(trend, /series\.length > 1[\s\S]*chart-legend/, 'legend renders only for two or more series');
assert.match(trend, /<details className="chart-table">[\s\S]*<summary[^>]*>Table<\/summary>/, 'every chart ships a native table twin');
assert.match(column, /<details className="chart-table">/, 'column chart ships a table twin');
assert.match(trend, /strokeWidth=\{?["']?2/, 'trend lines are 2px');
assert.doesNotMatch(trend, /strokeDasharray/, 'gridlines are solid hairlines, never dashed');
assert.match(column, /columnPaths\(/, 'columns use the shared geometry (≤24px, rounded caps)');

assert.match(trend, /partialLast \? '#ffffff' : s\.color/, 'an in-progress last bucket draws a hollow end-dot (never a dashed line)');
assert.match(trend, /\(so far\)/, 'the table twin marks the in-progress bucket');
assert.match(trend, /\{tools\}/, 'charts accept a tools slot for view toggles');

const kpi = read('src/components/analytics/KpiTile.tsx');
const delivery = read('src/components/analytics/DeliveryHealth.tsx');
const payingList = read('src/components/analytics/PayingEmployersList.tsx');

assert.doesNotMatch(kpi + delivery + payingList, /'use client'/, 'analytics tiles stay server components');
assert.match(delivery, /<svg[^>]*aria-hidden/, 'failure count carries an icon, never color alone');
assert.match(delivery, /className="delivery-fail"/, 'failure row uses the reserved danger treatment');
assert.match(payingList, /periodEndLabel\(/, 'period-end copy comes from the shared formatter');
assert.match(payingList, /className=\{`badge \$\{row\.status\}`\}/, 'status reuses the existing badge styles');

const analyticsPage = read('src/app/analytics/page.tsx');

assert.doesNotMatch(analyticsPage, /<th>Jobs posted<\/th>|<th>In-app out<\/th>|<th>Workers<\/th><th>Employers<\/th>/, 'time-series tables are gone from the page body (charts carry them; the table twins live inside the chart cards)');
assert.match(analyticsPage, /<TrendChart[\s\S]*title="Signups"/, 'signups is the hero TrendChart');
assert.match(analyticsPage, /<ColumnChart[\s\S]*title="Jobs posted"/, 'jobs posted renders as columns');
assert.match(analyticsPage, /<TrendChart[\s\S]*title="Applications"/, 'applications renders as a single-series trend');
assert.match(analyticsPage, /<DeliveryHealth/, 'message traffic renders as delivery health');
assert.match(analyticsPage, /<PayingEmployersList/, 'paying employers render as a list');
assert.match(analyticsPage, /className="kpi-strip"/, 'six KPI tiles sit in one strip');
assert.match(analyticsPage, /requireAdminSession\(\)/, 'the page still gates on an admin session');
assert.match(analyticsPage, /Promise\.all\(\[\s*getSignups/, 'the two-wave fetch (pool cap of 5) is preserved');
assert.doesNotMatch(analyticsPage, /function bucketLabel/, 'bucketLabel moved to analytics-format');
assert.match(analyticsPage, /cumulativeSeries\(/, 'signups default to a running total');
assert.match(analyticsPage, /parseSignupsView\(/, 'the signups view comes from the URL');
assert.match(analyticsPage, /analyticsHref\(/, 'range and view links preserve each other');
assert.match(analyticsPage, /label="Hires"/, 'hires replace the filled-jobs snapshot');
assert.doesNotMatch(analyticsPage, /label="Filled jobs"/, 'the filled-jobs tile is gone');
assert.equal((analyticsPage.match(/<KpiTile /g) ?? []).length, 6, 'the KPI strip keeps exactly six tiles');
assert.match(delivery, /failed or unconfirmed/, 'delivery failures are labeled honestly');
assert.match(delivery, /percentOf\(channel\.failed, channel\.out/, 'the failure rate is a share of outbound messages');

assert.match(trend, /right = 78/, 'TrendChart keeps the 78-unit default gutter and accepts a wider one');
assert.match(analyticsPage, /right=\{130\}/, 'the Signups chart widens its label gutter');
assert.doesNotMatch(analyticsPage, /so far/, 'New-view end labels are deltas, never a partial count');
assert.match(css, /\.chart-tools \{[^}]*flex-wrap: wrap;/, 'chart tool rows wrap so a view toggle never widens the page on phones');

// --- Next 16 async request APIs -------------------------------------------
// Next 16 removed the synchronous compatibility shim: cookies(), params and
// searchParams are Promises now. Reading a property off the un-awaited value
// does not throw -- it silently yields undefined -- and TypeScript cannot catch
// it either, because Next's generated page validator widens page props with
// `& any` (.next/types/validator.ts). So the contract is asserted here.
const sessionLib = read('src/lib/server/session.ts');
const sessionRoute = read('src/app/api/session/route.ts');

for (const [label, source] of [
  ['src/lib/server/session.ts', sessionLib],
  ['src/app/api/session/route.ts', sessionRoute],
]) {
  assert.match(source, /await cookies\(\)/, `${label} must await cookies() -- Next 16 removed the sync shim`);
  assert.doesNotMatch(
    source,
    /cookies\(\)\s*\.\s*get/,
    `${label} must not read a cookie off an un-awaited cookies()`,
  );
}

const caseDetail = read('src/app/cases/[id]/page.tsx');
const verificationDetail = read('src/app/verifications/[id]/page.tsx');

for (const [label, source] of [
  ['src/app/cases/[id]/page.tsx', caseDetail],
]) {
  assert.match(
    source,
    /params:\s*Promise<\{\s*id:\s*string;?\s*\}>/,
    `${label} must type params as a Promise (Next 16 dynamic route contract)`,
  );
  assert.match(source, /await params/, `${label} must await params before reading the route id`);
  assert.doesNotMatch(source, /\bparams\.id\b/, `${label} must not read .id off the un-awaited params Promise`);
}

// Roadmap 1b retired the verification review page with its actions; the route
// survives only as a redirect so old links land on the lockout list.
assert.match(
  verificationDetail,
  /redirect\('\/verifications'\)/,
  'the retired verification detail route must redirect to /verifications',
);
assert.doesNotMatch(
  verificationDetail,
  /AdminActionsPanel|getVerificationActions|getVerificationRecord/,
  'the retired verification detail route must not render actions or read a verification record',
);

assert.match(
  analyticsPage,
  /searchParams\??:\s*Promise</,
  'the analytics page must type searchParams as a Promise (Next 16 request API contract)',
);
assert.match(analyticsPage, /await searchParams/, 'the analytics page must await searchParams before reading the range');
assert.doesNotMatch(
  analyticsPage,
  /searchParams\?\.range/,
  'the analytics page must not read .range off the un-awaited searchParams Promise',
);

// --- Next 16 proxy file convention ----------------------------------------
// Next 16 renamed the middleware convention to `proxy`; src/middleware.ts is
// deprecated and stops being picked up in a later release. The rename also
// moves the hook off the Edge runtime onto Node, which does NOT change the
// security boundary: this layer still only checks cookie presence, and
// requireAdminSession() remains the real authz gate.
assert.equal(
  existsSync(resolve(root, 'src/proxy.ts')),
  true,
  'the request hook must live in src/proxy.ts (Next 16 renamed the middleware convention)',
);
assert.equal(
  existsSync(resolve(root, 'src/middleware.ts')),
  false,
  'src/middleware.ts must be gone -- two conventions would fight over the same matcher',
);

const proxyHook = read('src/proxy.ts');

assert.match(
  proxyHook,
  /export function proxy\(/,
  'the proxy file must export a function named `proxy`',
);
assert.doesNotMatch(
  proxyHook,
  /export function middleware\(/,
  'the old `middleware` export must be gone',
);
assert.match(
  proxyHook,
  /matcher:\s*\['\/\(\(\?!\.\*\\\\\.\.\*\)\.\*\)'\]/,
  'the proxy matcher must stay exactly as the middleware matcher was',
);
assert.match(
  proxyHook,
  /requireAdminSession\(\)/,
  'the proxy must keep the note that requireAdminSession() is the real authz boundary',
);

// --- Roadmap 1b: read-only lockout list and honest dashboard counts ---------
const verificationsPage = read('src/app/verifications/page.tsx');
const dashboardPage = read('src/app/page.tsx');

assert.match(
  nav,
  /\{ href: '\/verifications', label: 'Lockouts', exact: false \}/,
  'the nav must label /verifications "Lockouts"',
);
assert.match(verificationsPage, /listIdentityLockouts\(\)/, '/verifications must read the lockout list');
assert.doesNotMatch(
  verificationsPage,
  /AdminActionsPanel|className="button"|<form/,
  '/verifications is read-only: no actions, buttons, or forms',
);
assert.match(verificationsPage, /Web sign-up lockouts/, '/verifications must say web sign-up lockouts are not recorded');
for (const call of ['countOpenCasesByWait()', 'listOpenAdminCases(3)', 'countPiiRevealEvents()', 'listIdentityLockouts()']) {
  assert.ok(dashboardPage.includes(call), `the dashboard must call ${call}`);
}
assert.doesNotMatch(
  dashboardPage,
  /listAdminCases\(|listAuditEvents\(|listVerificationRecords/,
  'dashboard counts must come from their own queries, not a filtered page of rows',
);
assert.doesNotMatch(dashboardPage, /countOpenAdminCases\(/, 'the Open cases total comes from the by-wait counts (roadmap 2d)');
assert.match(dashboardPage, /Locked out \(\{LOCKOUT_WINDOW_DAYS\} days\)/, 'the dashboard tile must read "Locked out (7 days)"');
assert.equal(
  existsSync(resolve(root, 'src/lib/server/admin-verifications.ts')),
  false,
  'the verification-queue read model was retired (roadmap 1b)',
);

// --- Roadmap 2a: onboarding funnel page ------------------------------------
assert.equal(existsSync(resolve(root, 'src/app/analytics/funnels/page.tsx')), true, '/analytics/funnels exists');
const funnelsPage = read('src/app/analytics/funnels/page.tsx');
const tabs = read('src/components/analytics/AnalyticsTabs.tsx');
const funnelBars = read('src/components/analytics/FunnelBars.tsx');
const cohortTable = read('src/components/analytics/CohortTable.tsx');
const stalledList = read('src/components/analytics/StalledList.tsx');

assert.match(funnelsPage, /requireAdminSession\(\)/, 'the funnels page gates on an admin session');
assert.match(funnelsPage, /searchParams\??:\s*Promise</, 'the funnels page types searchParams as a Promise (Next 16)');
assert.match(funnelsPage, /await searchParams/, 'the funnels page awaits searchParams');
assert.match(
  funnelsPage,
  /Promise\.all\(\[\s*getOnboardingCohorts\(weeks\),\s*getOnboardingStalled\(\)\s*\]\)/,
  'the funnels page runs its two queries in one wave (pool cap of 5)',
);
assert.match(funnelsPage, /<AnalyticsTabs active="funnels"/, 'the funnels page shows the analytics tab row');
assert.doesNotMatch(funnelsPage, /<form|AdminActionsPanel/, 'the funnels page is read-only');
assert.match(tabs, /href: '\/analytics\/funnels'/, 'the tab row links to the funnels page');
assert.match(tabs, /aria-current/, 'the active tab is marked for assistive tech');
assert.doesNotMatch(
  tabs + funnelBars + cohortTable + stalledList,
  /'use client'/,
  'funnel components stay server components',
);
assert.match(cohortTable, /<table/, 'cohorts render as a real table');
assert.match(cohortTable, />settling</, 'still-moving weeks are labelled');
assert.match(funnelsPage, /showCode=\{door === 'whatsapp'\}/, 'the Code column appears only for the WhatsApp door');
assert.match(cohortTable, /className="card cohort-card"/, 'the cohort card can shrink below its table');
assert.match(css, /\.cohort-card \{[^}]*min-width: 0;/, 'a wide cohort table scrolls inside its card instead of widening the page');
assert.match(css, /\.table-scroll \{[^}]*overflow-x: auto;/, 'the cohort table scrolls horizontally inside its card');

assert.match(analyticsPage, /<AnalyticsTabs active="growth"/, 'the growth page shows the analytics tab row');
assert.match(analyticsPage, /key: 'verified'/, 'the signups chart has a verified-workers line');
assert.match(
  analyticsPage,
  /cumulativeSeries\(verifiedSignups, totals\.totalVerifiedWorkers\)/,
  'the verified running total ends at today\'s verified count',
);
assert.match(analyticsPage, /\$\{formatCount\(newVerified\)\} verified`/, 'the workers tile notes how many new workers verified');
assert.match(trend, /spreadLabels\(/, 'end labels are spread so close lines stay legible');

// --- Roadmap 2b: employer health page --------------------------------------
assert.equal(existsSync(resolve(root, 'src/app/analytics/employers/page.tsx')), true, '/analytics/employers exists');
const employersPage = read('src/app/analytics/employers/page.tsx');
const employerWeeklyTable = read('src/components/analytics/EmployerWeeklyTable.tsx');
const slowestEmployers = read('src/components/analytics/SlowestEmployers.tsx');
const staleJobsList = read('src/components/analytics/StaleJobsList.tsx');
const analyticsReadModel = read('src/lib/server/admin-analytics.ts');

assert.match(
  employersPage,
  /\) \{\n  await requireAdminSession\(\);\n  const \{ weeks: weeksParam \} = await searchParams;/,
  'the employers page gates on an admin session before reading anything',
);
assert.match(employersPage, /searchParams\??:\s*Promise</, 'the employers page types searchParams as a Promise (Next 16)');
assert.match(employersPage, /const weeks = parseFunnelWeeks\(weeksParam\);/, 'the weeks param is parsed like Funnels (4 / 8 / 12, default 8)');
assert.match(
  employersPage,
  /Promise\.all\(\[\s*getEmployerWeekly\(weeks\),\s*getSlowestEmployers\(weeks\),\s*getStaleJobs\(\),?\s*\]\)/,
  'the employers page runs its three queries in one wave (pool cap of 5)',
);
assert.match(
  employersPage,
  /const \{ weekly, summary \} = splitEmployerWeekly\(weeklyRows\);/,
  'the tiles read the SQL whole-window row, not a mean of the weeks',
);
for (const [pattern, point] of [
  [/<KpiTile label="First response" value=\{formatDuration\(summary\.firstResponseP50Hours\)\} note=\{firstResponseNote\(summary\)\} \/>/, 'First response'],
  [/<KpiTile label="Reply time" value=\{formatDuration\(summary\.replyP50Hours\)\} note=\{replyNote\(summary\)\} \/>/, 'Reply time'],
  [/<KpiTile label="Time to hire" value=\{formatDays\(summary\.timeToHireP50Days\)\} note=\{hiresNote\(summary\)\} \/>/, 'Time to hire'],
  [/<KpiTile label="Stale jobs" value=\{staleJobs\.length\} note=\{staleJobsNote\(summary\.activeJobs\)\} \/>/, 'Stale jobs'],
]) {
  assert.match(employersPage, pattern, `the ${point} tile is wired to the window summary`);
}
assert.equal((employersPage.match(/<KpiTile /g) ?? []).length, 4, 'the employers page has exactly four tiles');
for (const [pattern, point] of [
  [/admin_analytics_employer_weekly\(\$1\)',\s*\[weeks\],/, 'weekly(weeks)'],
  [/admin_analytics_slowest_employers\(\$1, \$2\)',\s*\[weeks, SLOWEST_EMPLOYERS_LIMIT\],/, 'slowest(weeks, 10)'],
  [/admin_analytics_stale_jobs\(\$1\)',\s*\[STALE_JOB_DAYS\],/, 'stale(14)'],
]) {
  assert.match(analyticsReadModel, pattern, `the read model calls ${point}`);
}
assert.match(employersPage, /<AnalyticsTabs active="employers"/, 'the employers page shows the analytics tab row');
assert.match(employersPage, /employersHref\(value\)/, 'the weeks picker links stay on the Employers tab');
assert.doesNotMatch(employersPage, /<form|AdminActionsPanel/, 'the employers page is read-only');
assert.match(
  tabs,
  /label: 'Growth'[\s\S]*label: 'Funnels'[\s\S]*\{ key: 'employers', label: 'Employers', href: '\/analytics\/employers' \}/,
  'the tab row reads Growth · Funnels · Employers',
);
assert.match(css, /\.analytics-tabs \{[^}]*flex-wrap: wrap;/, 'the tab row wraps on narrow phones instead of overflowing');
assert.match(kpi, /typeof value === 'number' \? formatCount\(value\) : value/, 'a tile can show a preformatted duration');
assert.match(
  employersPage,
  /const firstResponseSeries = weekly\.map\(\(week\) => week\.firstResponseP50Hours\);\n  const replySeries = weekly\.map\(\(week\) => week\.replyP50Hours\);/,
  'weeks with no median stay null (a gap), never 0',
);
assert.match(
  employersPage,
  /key: 'firstResponse',[\s\S]*values: firstResponseSeries,\n\s*endLabel: formatHours\([\s\S]*key: 'reply',[\s\S]*values: replySeries,\n\s*endLabel: formatHours\(/,
  'one chart, two weekly median lines, end labels in the axis unit (hours)',
);
assert.doesNotMatch(employersPage, /plots at 0|\?\? 0\)/, 'nothing on the chart is flattened to 0');
assert.match(employersPage, /<EmployerWeeklyTable rows=\{weeklyTableRows\(weekly, now\)\}/, 'the weekly table is newest first');
assert.match(employersPage, /<SlowestEmployers rows=\{slowest\}/, 'the slowest employers card is on the page');
assert.match(employersPage, /<StaleJobsList rows=\{staleJobs\} days=\{STALE_JOB_DAYS\}/, 'the stale jobs card is on the page');
assert.doesNotMatch(
  employerWeeklyTable + slowestEmployers + staleJobsList,
  /'use client'/,
  'employer health components stay server components',
);
for (const [label, source] of [
  ['EmployerWeeklyTable', employerWeeklyTable],
  ['SlowestEmployers', slowestEmployers],
  ['StaleJobsList', staleJobsList],
]) {
  assert.match(source, /className="card cohort-card"/, `${label}: the card can shrink below its table`);
  assert.match(
    source,
    /<div className="table-scroll" role="region" aria-label="[^"]+ table" tabIndex=\{0\}>\s*<table/,
    `${label}: the table scrolls inside its card, in a named, focusable region`,
  );
}
assert.match(css, /\.table-scroll:focus-visible \{/, 'a focused scroll region is visible');
for (const header of [
  'Week', 'Applications', 'Answered', 'Unanswered 7d', 'First response (p50 / p75)',
  'Worker messages', 'Reply (p50 / p75)', 'Hires', 'Time to hire',
]) {
  assert.ok(new RegExp(`<th[^>]*>${header.replace(/[()]/g, '\\$&')}</th>`).test(employerWeeklyTable), `weekly table column "${header}"`);
}
assert.match(employerWeeklyTable, /<td className="num">\{answeredLabel\(row\)\}<\/td>/, 'Answered shows how many answers have no time');
assert.match(employerWeeklyTable, />settling</, 'still-moving weeks are labelled');
assert.match(
  employerWeeklyTable,
  /title="Under 14 days old: unanswered counts are not final yet"/,
  'the settling badge does not claim figures are fixed after 7 days',
);
assert.doesNotMatch(employerWeeklyTable, /until 7 days after it ends/, 'the settling tooltip no longer promises a 7-day cutoff');
assert.match(employerWeeklyTable, />approx\.</, 'weeks with approximate hires are marked');
assert.match(slowestEmployers, /<h2>Slowest employers<\/h2>/);
assert.match(slowestEmployers, /<th className="num">Unanswered 7d<\/th>/, 'slowest employers uses the weekly table\'s Unanswered 7d header');
assert.match(slowestEmployers, /No employer has 3\+ applications in these weeks\./, 'slowest employers empty state');
assert.match(
  slowestEmployers,
  /<td className="wrap">\{employerLabel\(row\.displayName, row\.employerId\)\}<\/td>/,
  'employer names use the shared label and wrap',
);
assert.match(staleJobsList, /<h2>Stale jobs<\/h2>/);
assert.match(
  staleJobsList,
  /No active job has gone \{days\}\+ days without employer activity\./,
  'stale jobs empty state',
);
assert.match(staleJobsList, /firstWithRest\(rows, STALE_JOBS_SHOWN\)/, 'stale jobs shows the first 25');
assert.match(staleJobsList, /and \{formatCount\(more\)\} more/, 'the rest are counted, not listed');
assert.match(staleJobsList, /<td className="wrap">\{job\.title\}<\/td>/, 'long job titles wrap');
assert.match(staleJobsList, /<td className="wrap">\{employerLabel\(job\.displayName, job\.employerId\)\}<\/td>/, 'long employer names wrap');
assert.match(
  staleJobsList,
  /isIdleSincePosting\(job\) \? <span className="employer-note">since posting<\/span> : null/,
  'an idle clock that started at posting is marked',
);
assert.match(css, /\.cohort-table td\.wrap \{[^}]*white-space: normal;/, 'wrap cells override the tables\' nowrap');
const employersCopy = employersPage.replace(/\s+/g, ' '); // JSX text wraps across lines
for (const [pattern, point] of [
  [/What counts as an employer action:/, 'what counts as an employer action'],
  [/Status changes are recorded since Oct 2, 2026\./, 'status changes recorded since Oct 2'],
  [/Dropdown status changes before Oct 2 have no time, so they count as answered but not in the medians\./, 'untimed answers'],
  [/Employer actions taken only through the status dropdown before Oct 2 were not recorded, so some jobs show as idle since posting\./, 'idle since posting'],
  [/Hires from before hire times were recorded are marked approx\./, 'pre-095 hire times approximate'],
  [/Time to hire includes the worker completing their details\./, 'time to hire includes the worker completing details'],
  [/a run of consecutive messages from a worker counts once, and conversations closed without a reply are left out\./, 'what a worker message is'],
  [/The unanswered shares count only applications and worker messages at least 7 days old\./, 'the share denominators'],
  [/Deleted jobs drop out of every figure\./, 'deleted jobs drop out'],
  [/A job that was paused and reopened counts its idle days from the last employer action, which can be before the pause\./, 'reopened jobs count idle days from the last employer action'],
  [/Weeks marked settling are less than 14 days old, so their unanswered counts are not final; a late answer can still change an older week too\./, 'settling is defined'],
  [/Test employer accounts are left out\./, 'test employer accounts excluded'],
]) {
  assert.match(employersCopy, pattern, `the footnote says: ${point}`);
}
assert.match(css, /\.employer-approx \{/, 'the approx. marker has its own style');

// An open "Table" twin must scroll inside its chart card, never widen the page
// at phone width (/analytics and /analytics/employers alike).
assert.match(
  trend,
  /<details className="chart-table">[\s\S]*<\/summary>\s*<div className="table-scroll" role="region" aria-label=\{`\$\{title\} table`\} tabIndex=\{0\}>\s*<table className="data-table">/,
  "TrendChart's Table twin scrolls inside its card",
);
assert.match(trend, /<article className="card chart-card">/, 'a trend card can shrink below its open table');
assert.match(
  column,
  /<details className="chart-table">[\s\S]*<\/summary>\s*<div className="table-scroll" role="region" aria-label=\{`\$\{title\} table`\} tabIndex=\{0\}>\s*<table className="data-table">/,
  "ColumnChart's Table twin scrolls inside its card",
);
assert.match(column, /<article className="card chart-card">/, 'a column card can shrink below its open table');
assert.match(css, /\.chart-card,\s*\.chart-table \{[^}]*min-width: 0;/, 'chart cards and table twins may shrink below the table');
assert.match(css, /\.chart-tools,\s*\.chart-table \{[^}]*max-width: 100%;/, 'the tool row and the twin never outgrow their card');

// Gaps and round ticks: a null value is drawn as a gap, never as 0.
assert.match(trend, /values: \(number \| null\)\[\];/, 'a trend series may have gaps');
assert.match(trend, /isolatedPoints\(s\.values, plotW, plotH, max\)/, 'a lone point between gaps gets a dot');
assert.match(trend, /\{ended\.map\(\(s\) => \{/, 'a line whose last value is null has no end dot or label');
assert.match(trend, /value === null \? '—' : formatCount\(value \?\? 0\)/, 'the Table twin prints a gap as —');
assert.match(trend, /tickValues\(max, tickIntervals\(max\)\)/, 'trend ticks are round numbers');
assert.match(column, /tickValues\(max, tickIntervals\(max, \[2, 3, 4, 5\]\)\)/, 'column ticks are round numbers');

// --- Roadmap 2c: ops health page -----------------------------------------------
assert.equal(existsSync(resolve(root, 'src/app/analytics/ops/page.tsx')), true, '/analytics/ops exists');
const opsPage = read('src/app/analytics/ops/page.tsx');
const opsBacklog = read('src/components/analytics/MessageBacklog.tsx');
const opsFailures = read('src/components/analytics/MessageFailures.tsx');
const opsVoice = read('src/components/analytics/VoiceExtraction.tsx');
const opsTrust = read('src/components/analytics/TrustExtraction.tsx');
const opsBilling = read('src/components/analytics/BillingInbox.tsx');
// Literal markup as a pattern: `\s*` between pieces, everything else escaped.
const opsSeq = (...pieces) =>
  new RegExp(pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'));

// Page wiring: the session gate before any data, the weeks param, two waves of three.
assert.match(
  opsPage,
  /\) \{\n  await requireAdminSession\(\);\n  const \{ weeks: weeksParam \} = await searchParams;\n  const weeks = parseFunnelWeeks\(weeksParam\);/,
  'the ops page gates on an admin session before reading anything, then parses weeks like Funnels (4 / 8 / 12, default 8)',
);
assert.match(opsPage, /searchParams\??:\s*Promise</, 'the ops page types searchParams as a Promise (Next 16)');
assert.match(
  opsPage,
  /const \[backlog, failureRows, inboxNow\] = await Promise\.all\(\[\s*getMessageBacklog\(\),\s*getMessageFailures\(weeks\),\s*getBillingInboxNow\(\),?\s*\]\);\n  const \[voiceRows, trustRows, billingRows\] = await Promise\.all\(\[\s*getVoiceExtraction\(weeks\),\s*getTrustExtraction\(weeks\),\s*getBillingInbox\(weeks\),?\s*\]\);/,
  'six queries in two waves of three, the second after the first (pool cap of 5)',
);
assert.equal((opsPage.match(/Promise\.all\(/g) ?? []).length, 2, 'the ops page has exactly two query waves');
assert.equal((opsPage.match(/\bget[A-Z]\w*\(/g) ?? []).length, 6, 'the ops page issues exactly the six queries');
assert.match(
  opsPage,
  /const failures = splitMessageFailures\(failureRows\);\n  const voice = splitVoiceExtraction\(voiceRows\);\n  const trust = splitTrustExtraction\(trustRows\);\n  const billing = splitBillingInbox\(billingRows\);/,
  'tiles and sections read the SQL rows through the pure splitters (window rows, never sums of weeks)',
);
assert.match(
  opsPage,
  opsSeq(
    '<section className="kpi-strip funnel-kpis" aria-label="Key figures">',
    '<KpiTile label="Messages stuck now" value={stuckMessages(backlog)} note={messagesStuckNote(backlog, now)} />',
    '<KpiTile label="Billing events stuck" value={billingStuck(inboxNow)} note={billingStuckNote(inboxNow, now)} />',
    '<KpiTile label="Message failure rate" value={formatFailureRate(failures.window)} note={failureRateNote(failures.window)} />',
    '<KpiTile label="Voice extraction success" value={voiceSuccess(voice.window)} note={voiceSuccessNote(voice.window)} />',
    '</section>',
  ),
  'a named strip of exactly these four tiles, wired as the spec says',
);
assert.equal((opsPage.match(/<KpiTile /g) ?? []).length, 4, 'the ops page has exactly four tiles');
for (const [pattern, point] of [
  [/pool\.query<MessageBacklogRow>\('SELECT \* FROM admin_analytics_message_backlog\(\)'\)/, 'message_backlog()'],
  [/pool\.query<MessageFailuresRow>\(\s*'SELECT \* FROM admin_analytics_message_failures\(\$1\)',\s*\[weeks\],\s*\)/, 'message_failures(weeks)'],
  [/pool\.query<VoiceExtractionRow>\(\s*'SELECT \* FROM admin_analytics_voice_extraction\(\$1\)',\s*\[weeks\],\s*\)/, 'voice_extraction(weeks)'],
  [/pool\.query<TrustExtractionRow>\(\s*'SELECT \* FROM admin_analytics_trust_extraction\(\$1\)',\s*\[weeks\],\s*\)/, 'trust_extraction(weeks)'],
  [/pool\.query<BillingInboxRow>\(\s*'SELECT \* FROM admin_analytics_billing_inbox\(\$1\)',\s*\[weeks\],\s*\)/, 'billing_inbox(weeks)'],
  [/pool\.query<BillingInboxNowRow>\('SELECT \* FROM admin_analytics_billing_inbox_now\(\)'\)/, 'billing_inbox_now()'],
]) {
  assert.match(analyticsReadModel, pattern, `the read model calls ${point}`);
}
assert.match(
  analyticsReadModel,
  /if \(!row\) \{\n    throw new Error\('admin_analytics_billing_inbox_now\(\) returned no row'\);/,
  'a missing live billing row is an error, never "nothing stuck"',
);
assert.match(
  tabs,
  /label: 'Growth'[\s\S]*label: 'Funnels'[\s\S]*label: 'Employers'[\s\S]*\{ key: 'ops', label: 'Ops', href: '\/analytics\/ops' \}/,
  'the tab row reads Growth · Funnels · Employers · Ops',
);
for (const [page, key] of [[analyticsPage, 'growth'], [funnelsPage, 'funnels'], [employersPage, 'employers'], [opsPage, 'ops']]) {
  assert.match(page, new RegExp(`<AnalyticsTabs active="${key}" />`), `the ${key} page shows the four-tab row`);
}
assert.match(
  opsPage,
  opsSeq(
    '<nav className="range-picker" aria-label="Weeks">',
    '{WEEK_OPTIONS.map((value) => (',
    '<Link',
    'key={value}',
    'className="button"',
    'href={opsHref(value)}',
    "aria-current={value === weeks ? 'page' : undefined}",
    '>',
    '{value} weeks',
    '</Link>',
  ),
  'the weeks picker links stay on the Ops tab and mark the current choice',
);
assert.match(opsPage, /const WEEK_OPTIONS: FunnelWeeks\[\] = \[4, 8, 12\];/, 'the picker offers 4 / 8 / 12 weeks');
assert.match(
  opsPage,
  /Weeks change the weekly sections and the two rate tiles; stuck counts are always live\./,
  'the picker says what the weeks change',
);
assert.doesNotMatch(opsPage, /<form|AdminActionsPanel/, 'the ops page is read-only');
assert.match(
  opsPage,
  /<\/section>\n\n      <MessageBacklog lanes=\{backlog\} \/>\n      <MessageFailures failures=\{failures\} now=\{now\} \/>\n      <VoiceExtraction voice=\{voice\} now=\{now\} \/>\n      <TrustExtraction trust=\{trust\} now=\{now\} \/>\n      <BillingInbox billing=\{billing\} inbox=\{inboxNow\} now=\{now\} \/>/,
  'after the tiles, the sections follow the spec: backlog, failures, voice, trust, billing',
);

const opsSections = [
  ['MessageBacklog', opsBacklog],
  ['MessageFailures', opsFailures],
  ['VoiceExtraction', opsVoice],
  ['TrustExtraction', opsTrust],
  ['BillingInbox', opsBilling],
];
for (const [label, source] of opsSections) {
  assert.doesNotMatch(source, /'use client'/, `${label} stays a server component`);
  assert.match(source, /className="card cohort-card"/, `${label}: the card can shrink below its table`);
  const tables = (source.match(/<table/g) ?? []).length;
  const regions = (
    source.match(/<div className="table-scroll" role="region" aria-label="[^"]+ table" tabIndex=\{0\}>\s*<table className="data-table cohort-table">/g) ?? []
  ).length;
  assert.ok(tables > 0, `${label} renders a table`);
  assert.equal(regions, tables, `${label}: every table scrolls inside its card, in a named, focusable region`);
}
for (const [label, source] of opsSections.slice(1)) {
  assert.match(
    source,
    /row\.current \? <span className="cohort-settling" title="This week is still in progress">so far<\/span> : null/,
    `${label}: the current week is marked as still in progress`,
  );
}

// Every table's header row and cells, verbatim and in order: a renamed,
// reordered or rewired column fails here.
for (const [label, source, pieces] of [
  ['backlog header', opsBacklog, ['<tr>', '<th>Lane</th>', '<th className="num">Under 1 h</th>', '<th className="num">1–24 h</th>', '<th className="num">24–48 h</th>', '<th className="num">Stuck</th>', '</tr>']],
  ['backlog cells', opsBacklog, [
    '<td className="num">{formatCount(row.openUnder1h)}</td>',
    '<td className="num">{formatCount(row.open1To24h)}</td>',
    '<td className="num">{formatCount(row.open24To48h)}</td>',
    "<td className={row.stuck > 0 ? 'num ops-stuck' : 'num'}>{formatCount(row.stuck)}</td>",
  ]],
  ['failures header', opsFailures, ['<tr>', '<th>Week</th>', '{failures.lanes.map((lane) => (', '<th key={lane.lane} className="num">{lane.label}</th>', '))}', '</tr>']],
  ['failures cells', opsFailures, ['{row.cells.map((cell, i) => (', '<td key={failures.lanes[i].lane} className="num">{failedOfCreated(cell)}</td>', '))}']],
  ['failures total row', opsFailures, ['<tfoot>', '<tr>', '<th scope="row">These weeks</th>', '{failures.lanes.map((lane) => (', '<td key={lane.lane} className="num">{failedOfCreated(lane.window)}</td>']],
  ['voice header', opsVoice, ['<tr>', '<th>Week</th>', '<th className="num">Voice notes</th>', '<th className="num">Usable</th>', '<th className="num">Failed</th>', '<th>Top cause</th>', '</tr>']],
  ['voice cells', opsVoice, [
    '<td className="num">{formatCount(row.processed)}</td>',
    '<td className="num">{formatCount(row.usable)}</td>',
    '<td className="num">{formatCount(row.failed)}</td>',
    '<td className="wrap ops-cause">{topCauseLabel(row)}</td>',
  ]],
  ['completeness header', opsVoice, ['<tr>', '<th>Field</th>', '{completeness.columns.map((column) => (', "<th key={column.key} className={column.model ? 'num ops-model' : 'num'}>", '{column.label}', '<span className="ops-sub">{formatCount(column.usable)} usable</span>', '</th>']],
  ['completeness cells', opsVoice, ['<td className="wrap">{row.label}</td>', '{row.cells.map((cell, i) => (', '<td key={completeness.columns[i].key} className="num">', '{cell.share}', '<span className="ops-sub">{formatCount(cell.found)} of {formatCount(cell.of)}</span>']],
  ['trust header', opsTrust, ['<tr>', '<th>Week</th>', '<th>Version</th>', '<th className="num">Extractions</th>', '<th className="num">Failed</th>', '<th className="num">Not enough detail</th>', '<th className="num">Avg sections of 5</th>', '</tr>']],
  ['trust cells', opsTrust, [
    "<td>{row.version ?? '—'}</td>",
    '<td className="num">{formatCount(row.extractions)}</td>',
    '<td className="num">{formatCount(row.failed)}</td>',
    '<td className="num">{formatCount(row.notEnoughDetail)}</td>',
    '<td className="num">{formatAvgSections(row.avgSections)}</td>',
  ]],
  ['billing header', opsBilling, ['<tr>', '<th>Week</th>', '<th className="num">Received</th>', '<th className="num">Processed</th>', '<th className="num">Skipped</th>', '<th className="num">Failed</th>', '<th className="num">Retried</th>', '<th className="num">Payment-failed invoices</th>', '</tr>']],
  ['billing cells', opsBilling, [
    '<td className="num">{formatCount(row.received)}</td>',
    '<td className="num">{formatCount(row.processed)}</td>',
    '<td className="num">{formatCount(row.skipped)}</td>',
    '<td className="num">{formatCount(row.failed)}</td>',
    '<td className="num">{formatCount(row.retried)}</td>',
    '<td className="num">{formatCount(row.paymentFailedInvoices)}</td>',
  ]],
]) {
  assert.match(source, opsSeq(...pieces), `${label}: verbatim and in order`);
}
assert.equal((opsBacklog.match(/<th[\s>]/g) ?? []).length, 5, 'the backlog table has exactly five columns');
assert.equal((opsVoice.match(/<th[\s>]/g) ?? []).length, 7, 'voice: five weekly columns, then Field plus one column per completeness source');
assert.equal((opsTrust.match(/<th[\s>]/g) ?? []).length, 6, 'the trust table has exactly six columns');
assert.equal((opsBilling.match(/<th[\s>]/g) ?? []).length, 7, 'the billing table has exactly seven columns');

// Right now: message backlog.
assert.match(opsBacklog, /<h2>Right now: message backlog<\/h2>/);
assert.match(opsBacklog, /<p>Messages from the last 48 hours not sent yet \(waiting, retrying or in flight\), by how long ago they were created<\/p>/, 'the backlog says open means under 48 h');
assert.match(
  opsBacklog,
  /openMessages\(lanes\) === 0 \? \(\s*<p className="muted">No messages waiting\.<\/p>/,
  'nothing open: the backlog says so instead of a table of zeros',
);
assert.match(opsBacklog, /backlogRows\(lanes\)\.map/, 'lanes in display order with their labels');
assert.match(opsBacklog, /<span className="ops-sub">\{row\.stuckAfter\}<\/span>/, 'each lane shows its retry window');

// Message failures: one rate line per lane, gaps where a lane created nothing.
assert.match(
  opsFailures,
  /if \(failureChartEmpty\(failures\)\) \{[\s\S]*?<h2>Message failures by week<\/h2>[\s\S]*?<p className="muted">No messages created in these weeks\.<\/p>[\s\S]*?\n  \}/,
  'no lane created anything: an empty state, not a bare 0–1 axis',
);
assert.match(
  opsFailures,
  opsSeq(
    '<TrendChart',
    'title="Message failures by week"',
    'subtitle="Gave up + delivery failures, % of the messages each lane created that week · blank where a lane created nothing"',
    "labels={failures.weeks.map((week) => bucketLabel(week, '90d'))}",
    'tableCaption="Failure rate (%) by week"',
    'partialLast',
    'series={failures.lanes.map((lane) => {',
  ),
  'the failure chart: one point per week, the current week drawn as in progress',
);
assert.match(
  opsFailures,
  opsSeq(
    'const values = lane.weekly.map(failureRate);',
    'return {',
    'key: lane.lane,',
    'label: lane.label,',
    'color: LANE_COLORS[lane.lane],',
    'values,',
    'endLabel: latestRateLabel(lane),',
    '};',
  ),
  'one line per lane: its fixed color, null gaps (never 0%), the current week as the end label',
);
assert.doesNotMatch(opsFailures, /\?\? 0\)/, 'nothing on the failure chart is flattened to 0');
const opsLaneColors = opsFailures.match(/const LANE_COLORS: Record<MessageLane, string> = \{([\s\S]*?)\};/);
assert.ok(opsLaneColors, 'the lane colors are one fixed table');
const opsColorEntries = [...opsLaneColors[1].matchAll(/(\w+): '(#[0-9a-f]{6})',/g)].map((entry) => [entry[1], entry[2]]);
assert.deepEqual(
  opsColorEntries,
  [
    ['reply', '#0179ff'],
    ['admin', '#eb6834'],
    ['worker_notification', '#1baf7a'],
    ['employer_invite', '#eda100'],
    ['employer_freeform', '#e87ba4'],
    ['job_alert', '#008300'],
  ],
  'each lane keeps the validated color, in palette order',
);
assert.equal(new Set(opsColorEntries.map((entry) => entry[1])).size, 6, 'no two lanes share a color');

// AI voice extraction.
assert.match(opsVoice, /voice\.window\.processed === 0[\s\S]*<p className="muted">No voice notes in these weeks\.<\/p>/, 'voice empty state');
assert.match(opsVoice, /<h2>Why extractions failed<\/h2>/);
assert.match(opsVoice, /const reasons = failureReasons\(voice\.window\);/, 'causes come from the window row, incl. Cause not recorded');
assert.match(
  opsVoice,
  /<strong>\{formatCount\(reason\.count\)\}<\/strong> · \{wholePercent\(reason\.count, voice\.window\.failed\)\}/,
  "each cause's share is of the failures, not of every attempt",
);
assert.match(opsVoice, /<p className="muted">No failed extractions in these weeks\.<\/p>/);
assert.match(opsVoice, /<h2>Field completeness<\/h2>/);
assert.match(opsVoice, /const completeness = completenessTable\(voice\.window, voice\.models\);/, 'one column per model when more than one appears');

// Trust extraction.
assert.match(opsTrust, /<h2>Trust extraction<\/h2>/);
assert.match(opsTrust, /trust\.window\.extractions === 0 \? \(\s*<p className="muted">No trust extractions in these weeks\.<\/p>/, 'trust empty state');
assert.match(opsTrust, /newestWeeksFirst\(trust\.weekly, now\)\.map/, 'rows per extractor version, newest week first');

// Billing inbox.
assert.match(opsBilling, /<h2>Billing inbox<\/h2>/);
assert.match(opsBilling, /<strong>Right now:<\/strong> \{billingLiveLine\(inbox, now\)\}/, 'the live stuck / failed / unresolved line');
assert.match(opsBilling, /const empty = billing\.window\.received === 0;/, 'billing emptiness comes from the window row');
assert.match(
  opsBilling,
  /\{empty \? \(\s*<p className="muted">No billing events in these weeks\.<\/p>\s*\) : \(\s*<div className="table-scroll"/,
  'no events in these weeks: the weekly table gives way to the empty state',
);
assert.match(
  opsBilling,
  /\{empty \? null : \(\s*<article className="card">\s*<div className="chart-head" style=\{\{ marginBottom: 14 \}\}>\s*<div>\s*<h2>Skipped events by type<\/h2>/,
  'no events in these weeks: no skipped-events card either',
);
assert.match(opsBilling, /const skipped = skippedByType\(billing\.eventTypes\);/);
assert.match(opsBilling, /<p className="muted">No skipped events in these weeks\.<\/p>/);
assert.match(opsBilling, /<span className="funnel-label ops-code">\{type\.eventType\}<\/span>/, 'long event types wrap');

assert.match(css, /\.chart-legend \{[^}]*flex-wrap: wrap;/, 'a six-lane legend wraps on phones instead of widening the card');
assert.match(css, /\.chart-tools \{\n  min-width: 0;\n\}/, 'a Table twin wider than the card scrolls inside it at tablet widths too');
assert.match(css, /\.cohort-table td\.ops-stuck \{/, 'stuck cells have their own highlight');
assert.match(css, /\.cohort-table th\.ops-model \{[^}]*white-space: normal;[^}]*overflow-wrap: break-word;/, 'model-id headers wrap');
assert.match(css, /\.ops-code \{[^}]*overflow-wrap: anywhere;/, 'event types wrap');
assert.match(css, /\.cohort-table td\.ops-cause \{\n  min-width: 14rem;\n\}/, 'a tied top cause gets room for two causes per line');

const opsCopy = opsPage.replace(/\s+/g, ' '); // JSX text wraps across lines
for (const [pattern, point] of [
  [/WhatsApp replies 30 min, Admin replies 10 min, Worker notifications 24 h, Employer invites and Employer free-text messages 30 min, Job alerts \(old lane\) 30 min\./, 'the lane retry windows'],
  [/Open means created in the last 48 hours and not sent yet: waiting, retrying, or in flight\./, 'what open means'],
  [/WhatsApp replies are retried only while their incoming message is redelivered \(about 30 minutes\); after that they are stranded\./, 'replies are stranded after redelivery stops'],
  [/Worker notifications can legitimately wait up to 48 hours for a message template to be approved; the 24-hour mark matches the existing backlog alarm\./, 'worker notifications can wait 48 hours'],
  [/After 48 hours nothing retries a message, so anything still unsent counts as gave up\./, 'the 48-hour horizon'],
  [/Gave up also covers the last of 5 attempts failing, a send that ended with an unknown result, and any failed worker notification/, 'what else gave up means'],
  [/A delivery failure was sent, but Twilio reported it failed or undelivered\./, 'what a delivery failure is'],
  [/Free-text employer messages record delivery failures on the conversation, not in this lane;/, 'free-text delivery failures are counted elsewhere'],
  [/Deleting a job deletes its employer-message history\./, 'deleting a job deletes its employer-message history'],
  [/Job alerts now go out as worker notifications; only the old job-alert lane is dormant/, 'only the old job-alert lane is dormant'],
  [/Voice figures count only voice notes that produced a row, as attempts: a note processed twice counts twice, and a pipeline crash or timeout leaves no row, so that note is not counted\./, 'voice counts only notes that produced a row'],
  [/Failure causes are recorded only since migration 115 was applied; failed rows from before then show as Cause not recorded\./, 'causes are recorded only since 115'],
  [/Pipeline error also includes AI calls that timed out after 60 seconds and, occasionally, an extra row written after a successful save\./, 'what else Pipeline error covers'],
  [/confidence 0\.75 or higher, the threshold onboarding uses\./, 'completeness uses the onboarding threshold'],
  [/Test profiles are left out of the voice figures\./, 'test profiles are excluded from voice only'],
  [/Billing stuck means received but never claimed, or the 5-minute processing claim expired\./, 'billing stuck includes never-claimed events'],
  [/Billing events are retried for about 20 minutes; any still stuck or failed after an hour have been dead-lettered and can be redriven from the queue for 14 days\. Older ones have left the queue and must be resent from Stripe\./, 'billing retries stop after about 20 minutes; the queue keeps dead letters 14 days'],
  [/Weeks marked so far are still in progress, and messages that are still open can still add failures to their week\./, 'what so far means'],
]) {
  assert.match(opsCopy, pattern, `the footnote says: ${point}`);
}
for (const [pattern, point] of [
  [/Test profiles are left out\./, 'a page-wide test-profile claim'],
  [/nothing sends job alerts/, 'that job alerts stopped'],
  [/will retry/, 'that every failed billing event will be retried'],
  [/failed, retrying/, 'that every billing event that failed is still being retried'],
  [/dead-lettered and need a manual redrive\./, 'that every dead-lettered billing event can be redriven (the queue keeps them 14 days)'],
  [/Open means not sent yet, still retrying, or in flight\./, 'an open definition without the 48-hour horizon'],
]) {
  assert.doesNotMatch(opsCopy, pattern, `the footnote no longer claims ${point}`);
}

// --- Roadmap 2d: case aging (/cases, the case page, Home) ------------------
// Markup pins reuse 2c's opsSeq (literal pieces, `\s*` between them).
const casesPage = read('src/app/cases/page.tsx');

assert.match(
  dashboardPage,
  /AdminDashboardPage\(\) \{\n  await requireAdminSession\(\);\n/,
  'Home gates on an admin session before any query',
);
assert.match(
  dashboardPage,
  opsSeq(
    'const [openByWait, openCases, piiRevealCount, lockouts] = await Promise.all([',
    'countOpenCasesByWait(),',
    'listOpenAdminCases(3),',
    'countPiiRevealEvents(),',
    'listIdentityLockouts(),',
    ']);',
  ),
  'Home still runs its four queries in one wave (pool cap of 5)',
);
assert.match(
  dashboardPage,
  opsSeq('<span className="muted">Open cases</span>', '<strong>{openCasesTotal(openByWait)}</strong>', '<span>{waitingOnUsNote(openByWait)}</span>'),
  'the Open cases tile shows the total and how many wait on us',
);
assert.match(dashboardPage, /<h2>Open cases by wait<\/h2>/, 'Home has the Open cases by wait card');
assert.match(
  dashboardPage,
  /<p>Time in the current status \u00b7 a reply from the worker does not change it<\/p>/,
  'the card subtitle says a worker reply does not move a case (nothing does: Waiting on worker can be stale)',
);
assert.doesNotMatch(dashboardPage, /<p>Time in the current status<\/p>/, 'the bare subtitle is gone');
assert.match(
  dashboardPage,
  opsSeq(
    '<div className="table-scroll" role="region" aria-label="Open cases by wait table" tabIndex={0}>',
    '<table className="data-table cohort-table">',
  ),
  'the card is a real table in a named, focusable scroll region',
);
assert.match(
  dashboardPage,
  opsSeq(
    '{WAIT_BUCKETS.map((bucket) => (',
    '<th key={bucket.id} className="num" scope="col">{bucket.label}</th>',
    '))}',
    '<th className="num" scope="col">Total</th>',
  ),
  'the four wait columns, then Total, are column headers',
);
assert.match(
  dashboardPage,
  opsSeq('{WAIT_ROWS.map((row) => (', '<tr key={row.id}>', '<th scope="row">{row.label}</th>'),
  'Waiting on us / Waiting on worker are row headers',
);
assert.match(
  dashboardPage,
  opsSeq(
    '{WAIT_BUCKETS.map((bucket) => (',
    '<td key={bucket.id} className="num">{formatCount(openByWait[row.id][bucket.id])}</td>',
    '))}',
    '<td className="num">{formatCount(waitTotal(openByWait[row.id]))}</td>',
  ),
  'each row reads its own counts and its own total',
);
assert.match(dashboardPage, /\{casePreviewWait\(item, now\)\}/, 'each open-queue preview row says how long it has waited');
assert.match(
  casesPage,
  /await requireAdminSession\(\);\n  const \{ rows: adminCases, totalCount \} = await listAdminCases\(\);\n  const now = new Date\(\);/,
  '/cases gates on the session, then reads the queue',
);
assert.match(casesPage, /\{caseOpenedLine\(item, now\)\}/, 'each /cases row says when it was opened');
assert.match(casesPage, /\{caseWaitLine\(item, now\)\}/, 'each /cases row says who it waits on and for how long, or when it closed');
assert.match(
  caseDetail,
  opsSeq('<span>{caseOpenedMeta(item, now)}</span>', '<span>{caseStatusMeta(item, now)}</span>', '<span>Updated '),
  'the case page meta shows its age and time in status beside Updated',
);

// --- Roadmap 2d: start over and back (Funnels), applicant digest (Employers) ---
for (const [path, point] of [
  ['src/components/analytics/RestartsByStep.tsx', 'the Start over and back section'],
  ['src/components/analytics/OperatorResets.tsx', 'the Operator resets section'],
  ['src/components/analytics/DigestEmails.tsx', 'the Applicant digest emails card'],
]) {
  assert.equal(existsSync(resolve(root, path)), true, `${point} exists (${path})`);
}
const queuesRestarts = read('src/components/analytics/RestartsByStep.tsx');
const queuesResets = read('src/components/analytics/OperatorResets.tsx');
const queuesDigest = read('src/components/analytics/DigestEmails.tsx');
// opsSeq (2c, above): literal markup as a pattern, `\s*` between the pieces.

// Funnels: the session gate before any data, then two waves of two.
assert.match(
  funnelsPage,
  /\) \{\n  await requireAdminSession\(\);\n  const \{ weeks: weeksParam, door: doorParam \} = await searchParams;/,
  'the funnels page gates on an admin session before reading anything',
);
assert.match(
  funnelsPage,
  /const \[cohortRows, stalledRows\] = await Promise\.all\(\[getOnboardingCohorts\(weeks\), getOnboardingStalled\(\)\]\);\n  const \[restartRows, resetRows\] = await Promise\.all\(\[getOnboardingRestarts\(weeks\), getOperatorResets\(weeks\)\]\);/,
  'four queries in two waves of two, the second after the first (pool cap of 5)',
);
assert.equal((funnelsPage.match(/Promise\.all\(/g) ?? []).length, 2, 'the funnels page has exactly two query waves');
assert.equal((funnelsPage.match(/\bget[A-Z]\w*\(/g) ?? []).length, 4, 'the funnels page issues exactly the four queries');
assert.match(
  funnelsPage,
  /<CohortTable rows=\{tableRows\} showCode=\{door === 'whatsapp'\} \/>\n\n      <RestartsByStep rows=\{restartRows\} door=\{door\} weeks=\{weeks\} now=\{now\} \/>\n      <OperatorResets rows=\{resetRows\} now=\{now\} \/>/,
  'below the cohort table: start over and back (follows the door), then operator resets (no door)',
);

// Employers: the existing wave of three, then adoption + sends.
assert.match(
  employersPage,
  /const \[weeklyRows, slowest, staleJobs\] = await Promise\.all\(\[\s*getEmployerWeekly\(weeks\),\s*getSlowestEmployers\(weeks\),\s*getStaleJobs\(\),?\s*\]\);\n  const \[adoption, digestRows\] = await Promise\.all\(\[getDigestAdoption\(\), getDigestSends\(weeks\)\]\);/,
  'five queries in two waves: the existing three, then adoption + sends (pool cap of 5)',
);
assert.equal((employersPage.match(/Promise\.all\(/g) ?? []).length, 2, 'the employers page has exactly two query waves');
assert.equal((employersPage.match(/\bget[A-Z]\w*\(/g) ?? []).length, 5, 'the employers page issues exactly the five queries');
assert.match(employersPage, /const digest = splitDigestSends\(digestRows\);/, 'the digest total row is the SQL window row');
assert.match(
  employersPage,
  /<StaleJobsList rows=\{staleJobs\} days=\{STALE_JOB_DAYS\} \/>\n\n      <DigestEmails adoption=\{adoption\} sends=\{digest\} now=\{now\} \/>/,
  'the digest card sits below Stale jobs',
);

for (const [pattern, point] of [
  [/pool\.query<OnboardingRestartRow>\(\s*'SELECT \* FROM admin_analytics_onboarding_restarts\(\$1\)',\s*\[weeks\],\s*\)/, 'onboarding_restarts(weeks)'],
  [/pool\.query<OperatorResetRow>\(\s*'SELECT \* FROM admin_analytics_operator_resets\(\$1\)',\s*\[weeks\],\s*\)/, 'operator_resets(weeks)'],
  [/pool\.query<DigestAdoptionRow>\('SELECT \* FROM admin_analytics_digest_adoption\(\)'\)/, 'digest_adoption()'],
  [/pool\.query<DigestSendsRow>\(\s*'SELECT \* FROM admin_analytics_digest_sends\(\$1\)',\s*\[weeks\],\s*\)/, 'digest_sends(weeks)'],
]) {
  assert.match(analyticsReadModel, pattern, `the read model calls ${point}`);
}
assert.match(
  analyticsReadModel,
  /if \(!row\) \{\n    throw new Error\('admin_analytics_digest_adoption\(\) returned no row'\);/,
  'a missing adoption row is an error, never "digest on for 0%"',
);

const queuesSections = [
  ['RestartsByStep', queuesRestarts],
  ['OperatorResets', queuesResets],
  ['DigestEmails', queuesDigest],
];
for (const [label, source] of queuesSections) {
  assert.doesNotMatch(source, /'use client'/, `${label} stays a server component`);
  assert.match(source, /className="card cohort-card"/, `${label}: the card can shrink below its table`);
  const tables = (source.match(/<table/g) ?? []).length;
  const regions = (
    source.match(/<div className="table-scroll" role="region" aria-label="[^"]+ table" tabIndex=\{0\}>\s*<table className="data-table cohort-table">/g) ?? []
  ).length;
  assert.equal(tables, 1, `${label} renders one table`);
  assert.equal(regions, tables, `${label}: the table scrolls inside its card, in a named, focusable region`);
}
for (const [label, source] of queuesSections.slice(1)) {
  assert.match(
    source,
    /row\.current \? <span className="cohort-settling" title="This week is still in progress">so far<\/span> : null/,
    `${label}: the current week is marked as still in progress`,
  );
}

// Every table's header row and cells, verbatim and in order.
for (const [label, source, pieces] of [
  ['restarts header', queuesRestarts, ['<tr>', '<th>Step</th>', '<th className="num">Reached</th>', '<th className="num">Started over</th>', '<th className="num">Went back</th>', '<th className="num">Presses</th>', '</tr>']],
  ['restarts cells', queuesRestarts, [
    '{steps.map((row) => (',
    '<tr key={row.stepKey}>',
    '<td>{row.label}</td>',
    '<td className="num">{formatCount(row.reached)}</td>',
    '<td className="num">{row.startedOver}</td>',
    '<td className="num">{row.wentBack}</td>',
    '<td className="num">{formatCount(row.presses)}</td>',
  ]],
  ['restarts total row', queuesRestarts, [
    '<tfoot>',
    '<tr>',
    '<th scope="row">All steps</th>',
    '<td className="num">{formatCount(totals.reached)}</td>',
    '<td className="num">{totals.startedOver}</td>',
    '<td className="num">{totals.wentBack}</td>',
    '<td className="num">{formatCount(totals.presses)}</td>',
    '</tr>',
    '</tfoot>',
  ]],
  ['resets header', queuesResets, ['<tr>', '<th>Week</th>', '<th>Reason</th>', '<th className="num">Workers</th>', '<th className="num">Resets</th>', '</tr>']],
  ['resets cells', queuesResets, [
    '<td className="wrap restarts-reason">{row.reason}</td>',
    '<td className="num">{formatCount(row.workers)}</td>',
    '<td className="num">{formatCount(row.resets)}</td>',
  ]],
  ['digest header', queuesDigest, ['<tr>', '<th>Week</th>', '<th className="num">Emailed</th>', '<th className="num">Sent</th>', '<th className="num">Failed</th>', '<th className="num">Unknown</th>', '<th className="num">Still sending</th>', '<th className="num">Employers reached</th>', '</tr>']],
  ['digest cells', queuesDigest, [
    '<td className="num">{formatCount(row.emailed)}</td>',
    '<td className="num">{formatCount(row.sent)}</td>',
    '<td className="num">{formatCount(row.failed)}</td>',
    '<td className="num">{formatCount(row.unknown)}</td>',
    '<td className="num">{formatCount(row.inProgress)}</td>',
    '<td className="num">{formatCount(row.employersReached)}</td>',
  ]],
  ['digest total row', queuesDigest, [
    '<tfoot>',
    '<tr>',
    '<th scope="row">These weeks</th>',
    '<td className="num">{formatCount(sends.window.emailed)}</td>',
    '<td className="num">{formatCount(sends.window.sent)}</td>',
    '<td className="num">{formatCount(sends.window.failed)}</td>',
    '<td className="num">{formatCount(sends.window.unknown)}</td>',
    '<td className="num">{formatCount(sends.window.inProgress)}</td>',
    '<td className="num">{formatCount(sends.window.employersReached)}</td>',
    '</tr>',
    '</tfoot>',
  ]],
]) {
  assert.match(source, opsSeq(...pieces), `${label}: verbatim and in order`);
}
assert.equal((queuesRestarts.match(/<th[\s>]/g) ?? []).length, 6, 'the start over and back table has five columns and a total row');
assert.equal((queuesResets.match(/<th[\s>]/g) ?? []).length, 4, 'the operator resets table has exactly four columns');
assert.equal((queuesDigest.match(/<th[\s>]/g) ?? []).length, 8, 'the digest table has seven columns and a total row');

// Start over and back.
assert.match(queuesRestarts, /<h2>Start over and back<\/h2>/);
assert.match(
  queuesRestarts,
  /if \(restartsEmpty\(rows, door\)\) \{[\s\S]*?<p className="muted">No one started over or went back in these weeks\.<\/p>[\s\S]*?\n  \}/,
  'nobody pressed: an empty state instead of a table and a flat chart',
);
assert.match(queuesRestarts, /const steps = restartStepRows\(rows, door\);/, 'the door\'s whole-window step rows, in onboarding order');
assert.match(
  queuesRestarts,
  /const totals = restartTotals\(rows, door\);/,
  'the total row is the SQL all-steps row (workers distinct across steps), never a sum of the steps',
);
assert.match(
  queuesRestarts,
  /\{startOver \? null : <p className="muted restarts-note">No start over on the web<\/p>\}/,
  'the web door says why Started over is a dash',
);
assert.match(
  queuesRestarts,
  opsSeq(
    '<TrendChart',
    'title="Start over and back by week"',
  ),
  'the weekly chart',
);
assert.match(
  queuesRestarts,
  opsSeq(
    "labels={byWeek.map((week) => bucketLabel(week.weekStart, '90d'))}",
    'tableCaption="Workers by week"',
    'partialLast',
    'series={startOver ? [startedOver, wentBack] : [wentBack]}',
  ),
  'one point per week of the window, the current week in progress; no start-over line on the web',
);
assert.match(queuesRestarts, /const byWeek = restartWeeks\(rows, door, weeks, now\);/, 'every week of the window, zero-filled');
assert.match(queuesRestarts, /label: 'Started over',\n    color: STARTED_OVER_BLUE,\n    values: byWeek\.map\(\(week\) => week\.restartWorkers\),/, 'workers who started over, distinct across steps');
assert.match(queuesRestarts, /label: 'Went back',\n    color: WENT_BACK_ORANGE,\n    values: byWeek\.map\(\(week\) => week\.backWorkers\),/, 'workers who went back, distinct across steps');
assert.match(queuesRestarts, /const STARTED_OVER_BLUE = '#0179ff';\nconst WENT_BACK_ORANGE = '#eb6834';/, 'the validated blue / orange pair');

// Operator resets.
assert.match(queuesResets, /<h2>Operator resets<\/h2>/);
assert.match(queuesResets, /<p>Operator resets have no door, so this table shows every door\.<\/p>/, 'the resets table says it ignores the door picker');
assert.match(queuesResets, /const tableRows = resetTableRows\(rows, now\);/, 'bulk runs are left out of the table');
assert.match(
  queuesResets,
  opsSeq(
    '{tableRows.length === 0 ? (',
    '<p className="muted">',
    "{bulkNote === null ? 'No operator resets in these weeks.' : 'No other operator resets in these weeks.'}",
    '</p>',
    ') : (',
  ),
  'operator resets empty state; with only bulk runs it says no OTHER resets, so it does not contradict the bulk note',
);
assert.match(queuesResets, /const bulkNote = bulkRunsNote\(rows, now\);/);
assert.match(
  queuesResets,
  /\{bulkNote === null \? null : <p className="muted restarts-note">\{bulkNote\}<\/p>\}/,
  'bulk runs are listed under the table, also when the table is empty',
);
assert.match(
  queuesResets,
  opsSeq('</table>', '</div>', ')}', '{bulkNote === null ? null : <p className="muted restarts-note">{bulkNote}</p>}', '</article>'),
  'the bulk note sits outside the table branch, so it shows under the empty state too',
);

// Applicant digest emails.
assert.match(queuesDigest, /<h2>Applicant digest emails<\/h2>/);
assert.match(queuesDigest, /<p className="digest-adoption">\{adoptionLine\(adoption\)\}<\/p>/, 'the adoption line always shows');
assert.match(
  queuesDigest,
  /\{digestEmpty\(sends\) \? \(\s*<p className="muted">No digest emails in these weeks\.<\/p>\s*\) : \(\s*<div className="table-scroll"/,
  'nothing emailed in these weeks: the table gives way to the empty state',
);
assert.match(queuesDigest, /\{digestTableRows\(sends, now\)\.map\(\(row\) => \(/, 'newest week first');

const funnelsCopy = funnelsPage.replace(/\s+/g, ' '); // JSX text wraps across lines
for (const [pattern, point] of [
  [/voice-note retry loops and system moves do not count as going back\./, 'retry loops and system moves are not going back'],
  [/Workers reset by an operator lose their onboarding history, so their earlier restarts are not counted/, 'resets delete earlier restarts'],
  [/Reached counts the workers who were at a step in these weeks: they arrived there, or started over or went back from it\./, 'what Reached counts'],
  [/All steps and the weekly chart count each worker once, so the steps can add up to more; Presses count every press/, 'workers once across steps, presses add up'],
  [/On All, the start-over share is of every worker who was at the step, web included\./, 'the All door start-over share'],
  [/a reason used for 10 or more workers within an hour is a bulk run, left out of the counts and listed under the table\./, 'the bulk rule'],
  [/Start over and back counts moves made since the last operator reset of each worker\./, 'moves since the last reset count'],
  [/Reasons are typed by operators; long numbers, emails and IDs are hidden\./, 'reasons are masked: long numbers, emails and IDs'],
]) {
  assert.match(funnelsCopy, pattern, `the funnels footnote says: ${point}`);
}
for (const [pattern, point] of [
  [/can pass 100%/, 'that a share can pass 100% (Reached includes everyone who pressed)'],
  [/Presses and the chart count every press/, 'that the chart counts presses (it counts workers)'],
  [/Runs of 4 or more digits in a reason are masked\./, 'the old mask rule (phone-like runs are hidden too)'],
  [/Reasons are typed by operators; long numbers are hidden\./, 'the old mask sentence (emails and IDs are hidden too)'],
]) {
  assert.doesNotMatch(funnelsCopy, pattern, `the funnels footnote no longer claims ${point}`);
}
const digestCopy = employersPage.replace(/\s+/g, ' ');
for (const [pattern, point] of [
  [/Applicant digest emails launched on Aug 23, 2026, so earlier weeks are empty\./, 'the launch date'],
  [/only on days with new applicants/, 'emailed only on days with new applicants'],
  [/Unknown means the send timed out and may have arrived \(it is never retried\)/, 'what Unknown means'],
  [/Bounces and spam complaints switch the digest off for that employer but do not show as failures\./, 'bounces and complaints are not failures'],
  [/Failed means the send gave up after 5 attempts; .*Still sending means queued or waiting to retry\./, 'Failed and Still sending'],
  [/Employers reached counts employers with at least one digest sent\./, 'what Employers reached counts'],
]) {
  assert.match(digestCopy, pattern, `the employers footnote says: ${point}`);
}

assert.match(css, /\.restarts-note \{[^}]*overflow-wrap: anywhere;/, 'a long bulk-run reason wraps inside its card');
assert.match(css, /\.cohort-table td\.restarts-reason \{\n  min-width: 14rem;\n\}/, 'a long reason keeps room for a few words per line on phones');
assert.match(css, /\.digest-adoption \{/, 'the adoption line has its own spacing');

console.log('admin UI contract checks passed');
