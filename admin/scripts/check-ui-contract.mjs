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
  ['src/app/verifications/[id]/page.tsx', verificationDetail],
]) {
  assert.match(
    source,
    /params:\s*Promise<\{\s*id:\s*string;?\s*\}>/,
    `${label} must type params as a Promise (Next 16 dynamic route contract)`,
  );
  assert.match(source, /await params/, `${label} must await params before reading the route id`);
  assert.doesNotMatch(source, /\bparams\.id\b/, `${label} must not read .id off the un-awaited params Promise`);
}

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

console.log('admin UI contract checks passed');
