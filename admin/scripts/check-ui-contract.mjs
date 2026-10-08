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
for (const call of ['countOpenAdminCases()', 'listOpenAdminCases(3)', 'countPiiRevealEvents()', 'listIdentityLockouts()']) {
  assert.ok(dashboardPage.includes(call), `the dashboard must call ${call}`);
}
assert.doesNotMatch(
  dashboardPage,
  /listAdminCases\(|listAuditEvents\(|listVerificationRecords/,
  'dashboard counts must come from their own queries, not a filtered page of rows',
);
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

console.log('admin UI contract checks passed');
