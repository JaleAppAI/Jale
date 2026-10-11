import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
assert.match(verificationsPage, /loadLockouts\(session\)/, '/verifications must read the lockout list through its recorded loader');
assert.doesNotMatch(
  verificationsPage,
  /AdminActionsPanel|className="button"|<form/,
  '/verifications is read-only: no actions, buttons, or forms',
);
assert.match(verificationsPage, /Web sign-up lockouts/, '/verifications must say web sign-up lockouts are not recorded');
// The dashboard's tiles keep their own queries, now inside the one recorded
// read transaction; the reveal tile reads the access
// records through jale_audit.reveal_count, not admin_audit_log.
const casesModule = read('src/lib/server/admin-cases.ts');
assert.match(dashboardPage, /loadAdminDashboard\(session\)/, 'the dashboard must load through its recorded loader');
for (const call of [
  'countOpenAdminCases(client)',
  'listOpenAdminCaseRows(client, DASHBOARD_PREVIEW_SIZE)',
  'countRecentReveals(client, REVEAL_TILE_DAYS)',
  'listIdentityLockouts(client)',
]) {
  assert.ok(casesModule.includes(call), `the dashboard loader must call ${call}`);
}
assert.match(dashboardPage, /Contact reveals \(\{REVEAL_TILE_DAYS\} days\)/, 'the reveal tile names its window');
assert.doesNotMatch(read('src/lib/server/admin-audit.ts'), /FROM admin_audit_log WHERE pii_reveal/, 'the reveal tile no longer counts admin_audit_log rows');
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

// --- The Reports inbox -------------------------------------------------------
const reportsPage = read('src/app/reports/page.tsx');
const reportDetail = read('src/app/reports/[id]/page.tsx');
const reportSettings = read('src/app/reports/settings/page.tsx');
const reportPanel = read('src/components/ReportActionsPanel.tsx');
const reportFilters = read('src/components/ReportFilters.tsx');
const copyButton = read('src/components/CopyButton.tsx');
const layout = read('src/app/layout.tsx');
const nextConfig = read('next.config.mjs');

for (const [label, source] of [
  ['src/app/reports/page.tsx', reportsPage],
  ['src/app/reports/[id]/page.tsx', reportDetail],
  ['src/app/reports/settings/page.tsx', reportSettings],
]) {
  assert.match(source, /const session = await requireAdminSession\(\)/, `${label} gates on an admin session`);
  assert.doesNotMatch(source, /'use client'/, `${label} stays a server component`);
}

// Next 16 async request APIs, as for the case pages and analytics.
assert.match(reportsPage, /searchParams\??:\s*Promise</, 'the reports list must type searchParams as a Promise');
assert.match(reportsPage, /await searchParams/, 'the reports list must await searchParams before reading the filters');
assert.match(reportDetail, /params:\s*Promise<\{\s*id:\s*string;?\s*\}>/, 'the report page must type params as a Promise');
assert.match(reportDetail, /await params/, 'the report page must await params before reading the id');
assert.doesNotMatch(reportDetail, /\bparams\.id\b/, 'the report page must not read .id off the un-awaited params');

// Every read goes through the recorded read models.
assert.match(reportsPage, /listProblemReports\(session, filters\)/, 'the list reads through the recorded inbox read model');
assert.match(reportDetail, /getProblemReport\(session, id\)/, 'the report page reads through the recorded detail read model');
assert.match(reportDetail, /notFound\(\)/, 'an unknown report is a 404');
assert.match(reportSettings, /canReport\(session\.role, 'view_settings'\)/, 'the settings page is for superadmins');
assert.match(reportSettings, /recordReportSettingsDenied\(session\)/, 'a refused settings view is a recorded attempt');
assert.match(reportSettings, /getProblemReportSettings\(session\)/, 'the settings read is recorded');
assert.match(reportSettings, /getAdminAuthConfig\(\)\.hostedDomain/, 'the dashboard address defaults to the admin app origin');

// The action controls come from the policy, so read-only roles never get them.
for (const capability of ['reveal_contact', 'view_screenshot', 'set_status', 'set_note']) {
  assert.match(reportDetail, new RegExp(`canReport\\(role, '${capability}'\\)`), `the report page gates ${capability} on the policy`);
}

// The words are plain text in a wrapping block. No raw HTML anywhere.
assert.match(reportDetail, /className="report-words"/, 'the report words render in their wrapping block');
assert.match(css, /\.report-words \{[^}]*white-space: pre-wrap;/, 'the words keep their line breaks and wrap');
for (const entry of readdirSync(resolve(root, 'src'), { recursive: true })) {
  if (!/\.(ts|tsx)$/.test(entry)) continue;
  assert.doesNotMatch(read(`src/${entry}`), /dangerouslySetInnerHTML/, `src/${entry} renders text only`);
}

// The nav badge has its own COUNT query; it is never derived from a list.
assert.match(nav, /\{ href: '\/reports', label: 'Reports', exact: false \}/, 'the nav has a Reports entry');
assert.match(nav, /reportsNewCount/, 'the Reports entry carries the new-report count');
assert.match(layout, /session \? await getProblemReportCounts\(\) : null/, 'the count is read only for a signed-in admin');
assert.doesNotMatch(layout, /listProblemReports\(/, 'the badge never counts a page of rows');

// Filters are a plain GET form: no client code and no request body to sign.
assert.doesNotMatch(reportFilters, /'use client'/, 'the filters stay a server component');
assert.match(reportFilters, /method="get"/);
assert.match(reportFilters, /action="\/reports"/);

// Actions: the manual RPC with the payload hash and the same follow-up
// pointer as AdminActionsPanel; screenshots open in a new tab with no opener.
assert.match(reportPanel, /^'use client';/);
assert.match(reportPanel, /pendingActionId/, 'action loading state tracks the submitted action');
const manualRpcFollowUp = /follow-up (F\d+)/.exec(actions)?.[1];
assert.ok(manualRpcFollowUp, 'AdminActionsPanel names the follow-up that revisits its manual RPC');
assert.match(
  reportPanel,
  new RegExp(`follow-up ${manualRpcFollowUp}\\b`),
  'the manual RPC points at the same follow-up as AdminActionsPanel',
);
assert.match(reportPanel, /'x-amz-content-sha256': payloadHash/, 'every action carries the SHA-256 payload hash');
assert.match(reportPanel, /fetch\('\/api\/report-actions'/, 'actions post to their own route');
assert.match(reportPanel, /window\.open\(result\.url, '_blank', 'noopener,noreferrer'\)/, 'screenshots open in a new tab with no opener');
assert.match(reportPanel, /rel="noopener noreferrer"/, 'the fallback link carries no opener either');
assert.doesNotMatch(reportPanel + copyButton, /localStorage|sessionStorage|indexedDB/, 'a revealed contact or a link is never stored');
assert.doesNotMatch(reportPanel + copyButton, /console\./, 'the client never logs a value');
assert.match(copyButton, /^'use client';/);
assert.match(copyButton, /navigator\.clipboard\.writeText/);
assert.match(nextConfig, /"img-src 'self' data:"/, 'the admin CSP is unchanged: screenshots open by navigation');

// The case console is untouched: its dispatch and vocabularies stay case-only.
for (const path of [
  'src/lib/action-policy.ts',
  'src/lib/action-requests.ts',
  'src/lib/audit-contract.ts',
  'src/lib/server/admin-action-dispatch.ts',
  'src/components/AdminActionsPanel.tsx',
  'src/app/api/admin-actions/route.ts',
  'src/app/actions.ts',
]) {
  assert.doesNotMatch(read(path), /report/i, `${path} stays case-only`);
}

// --- Access records: every page that shows personal data
// loads through a loader that records what it shows before COMMIT. A page
// that reached the pool directly would show data with no record.
const casesPage = read('src/app/cases/page.tsx');
for (const [label, source, loader] of [
  ['src/app/page.tsx', dashboardPage, /loadAdminDashboard\(session\)/],
  ['src/app/cases/page.tsx', casesPage, /loadCasesList\(session\)/],
  ['src/app/cases/[id]/page.tsx', caseDetail, /loadCaseDetail\(session, id\)/],
  ['src/app/verifications/page.tsx', verificationsPage, /loadLockouts\(session\)/],
  ['src/app/analytics/page.tsx', analyticsPage, /loadPayingEmployers\(session\)/],
  ['src/app/reports/page.tsx', reportsPage, /listProblemReports\(session, filters\)/],
  ['src/app/reports/[id]/page.tsx', reportDetail, /getProblemReport\(session, id\)/],
  ['src/app/reports/settings/page.tsx', reportSettings, /getProblemReportSettings\(session\)/],
]) {
  assert.match(source, /const session = await requireAdminSession\(\)/, `${label} must keep the session it records under`);
  assert.match(source, loader, `${label} must load through its recorded loader`);
  assert.doesNotMatch(source, /getAdminDbPool|@\/lib\/server\/db['"]/, `${label} must not read the pool directly`);
}
assert.match(
  analyticsPage,
  /Promise\.all\(\[\s*getAnalyticsTotals\(\),\s*loadPayingEmployers\(session\),?\s*\]\)/,
  'only the paying-employers list is recorded, in the second wave',
);

// --- Admin links never prefetch ----------------------------------------------
// Admin links never prefetch: a page may record a read when it renders, and a
// prefetch must never record a read the admin did not make. So every Link in
// the app carries a literal prefetch={false}. Tags are matched over each whole
// file, so a tag written over several lines counts too, and next/link is only
// ever imported as Link, so the scan sees every one.
const adminLinks = [];
for (const entry of readdirSync(resolve(root, 'src'), { recursive: true })) {
  if (!/\.tsx?$/.test(entry)) continue;
  const source = read(`src/${entry}`);
  for (const imported of source.matchAll(/import\s+(\w+)\s+from\s+['"]next\/link['"]/g)) {
    assert.equal(imported[1], 'Link', `src/${entry} imports next/link as Link`);
  }
  if (!entry.endsWith('.tsx')) continue;
  for (const tag of source.matchAll(/<Link\b[^>]*>/g)) {
    adminLinks.push({ at: `src/${entry}:${source.slice(0, tag.index).split('\n').length}`, tag: tag[0] });
  }
}
// A floor, so a scan that finds nothing cannot pass.
assert.ok(adminLinks.length >= 20, `the link scan found ${adminLinks.length} links; expected at least 20`);
const prefetching = adminLinks.filter(({ tag }) => !/\bprefetch=\{false\}/.test(tag)).map(({ at }) => at);
assert.deepEqual(prefetching, [], `admin links never prefetch; without a literal prefetch={false}: ${prefetching.join(', ')}`);
// The nav's entries share one link, which never prefetches; no entry chooses.
assert.match(nav, /<Link\b[^>]*\bprefetch=\{false\}[^>]*>\s*\{label\}/, 'the nav link never prefetches');
assert.doesNotMatch(nav, /prefetch\?:|prefetch: false|prefetch=\{prefetch\}/, 'no nav entry chooses its own prefetch');

// --- The reveal reason: it is recorded, so the form says so
// and caps it at the 500 characters the access record accepts.
assert.match(actions, /The reason is recorded\. Do not include personal details\./, 'the reveal form warns that the reason is recorded');
assert.match(actions, /name="justification"[\s\S]*?maxLength=\{500\}|maxLength=\{500\}[\s\S]*?name="justification"/, 'the reveal reason is capped at 500 characters');
assert.match(actions, /minLength=\{20\}/, 'the 20-character minimum stays');
assert.match(actions, /aria-describedby=\{`\$\{adminAction\.id\}-reason-hint`\}/, 'the warning is tied to the reason field');

// --- The access history ------------------------------------------------------
// /audit read admin_audit_log directly. It now redirects to the access
// history, which reads every record through jale_audit.history_search.
const auditPage = read('src/app/audit/page.tsx');
assert.match(auditPage, /redirect\('\/access-history'\)/, '/audit must redirect to the access history');
assert.doesNotMatch(auditPage, /listAuditEvents|admin_audit_log|getAdminDbPool/, '/audit must not read the action log any more');

const historyPage = read('src/app/access-history/page.tsx');
assert.match(historyPage, /const session = await requireAdminSession\(\)/, 'the access history gates on an admin session');
assert.match(historyPage, /searchParams:\s*Promise</, 'the access history types searchParams as a Promise (Next 16)');
assert.match(historyPage, /loadAccessHistory\(session, await searchParams\)/, 'the access history loads through its loader');
assert.doesNotMatch(historyPage, /getAdminDbPool|@\/lib\/server\/db['"]|\.query\(|SELECT /, 'the access history page never reads the database itself');

const historyView = read('src/components/access-history/AccessHistoryView.tsx');
const historyFilters = read('src/components/access-history/AccessHistoryFilters.tsx');
const localTime = read('src/components/LocalTime.tsx');
// Nothing in the view can change an entry: no action panel, no POST form,
// no server action, no fetch.
for (const [label, source] of [
  ['src/app/access-history/page.tsx', historyPage],
  ['AccessHistoryView.tsx', historyView],
  ['AccessHistoryFilters.tsx', historyFilters],
]) {
  assert.doesNotMatch(
    source,
    /AdminActionsPanel|method=["']post["']|@\/app\/actions|'use server'|fetch\(/i,
    `${label}: the access history has no edit controls`,
  );
}
assert.match(historyFilters, /^'use client';/, 'the search form is the only client island with state');
assert.match(historyFilters, /role="search"/, 'the filters are a search landmark');
assert.doesNotMatch(historyView, /'use client'/, 'the entries render on the server');
// Every search is recorded, so its links never prefetching matters here most:
// a prefetch would run a search the admin did not make, one per link on a page
// of ids. The app-wide link rule above pins it.
assert.match(localTime, /^'use client';/);
assert.match(localTime, /useSyncExternalStore/, 'times switch to the viewer zone after hydration, with no mismatch');
assert.match(localTime, /<time dateTime=\{iso\}/, 'times are machine-readable');

// The navigation shows the access history to superadmins only.
assert.match(
  nav,
  /\{ href: '\/access-history', label: 'Access history', exact: false, superadminOnly: true \}/,
  'the nav must link "Access history" for superadmins',
);
assert.doesNotMatch(nav, /href: '\/audit'/, 'the nav must not link the retired /audit page');
assert.match(nav, /superadminOnly\?: boolean/, 'the flag is optional, so other entries need not set it');
assert.match(nav, /superadminOnly && role !== 'admin_superadmin'/, 'a superadmin-only link is hidden from other roles');
assert.match(read('src/app/layout.tsx'), /<AdminNav[^>]*role=\{session\?\.role\}/, 'the layout passes the role to the nav');

// Each case links to the access history of its person, for superadmins.
assert.match(caseDetail, /Access history for this person/, 'case detail links to the person\'s access history');
assert.match(caseDetail, /accessHistoryHref\(\{ subjectUserId: item\.workerId \}\)\}\s*prefetch=\{false\}/, 'the link filters by the case\'s person and is never prefetched');
assert.match(caseDetail, /role === 'admin_superadmin' && isUuid\(item\.workerId\)/, 'the link shows for superadmins, and only for a real person id');

assert.doesNotMatch(read('src/app/actions.ts'), /revalidatePath\('\/audit'\)/, 'actions revalidate the access history, not the retired page');
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

console.log('admin UI contract checks passed');
