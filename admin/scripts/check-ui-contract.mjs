import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

console.log('admin UI contract checks passed');
