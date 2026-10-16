// Admin UI contract: the analytics pages and components (FE-4, sprint 28).
// The four tabs load in waves of at most three queries (K3.0), tag all 21
// list items, keep every older panel, and render with test-only K3-shaped
// loaders (scripts/fixtures/fe4-loaders.mjs); every analytics file is a
// server component with token colours and no legacy class names (D11).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { read, root } from './lib/ui-contract-helpers.mjs';

// ==== S28 FE-4: shared helpers for the D11 page contracts ====
import { readdirSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileAdminSources } from './lib/check-harness.mjs';

const FE4_PAGES = {
  growth: 'src/app/(console)/analytics/page.tsx',
  funnels: 'src/app/(console)/analytics/funnels/page.tsx',
  employers: 'src/app/(console)/analytics/employers/page.tsx',
  ops: 'src/app/(console)/analytics/ops/page.tsx',
};
const fe4Source = Object.fromEntries(Object.entries(FE4_PAGES).map(([tab, path]) => [tab, read(path)]));
const fe4Flat = (text) => text.replace(/\s+/g, ' '); // JSX text and props wrap across lines

// Every `await Promise.all([...])` of a page, in order, as the loader names it
// calls; and every loader call left outside a wave (there must be none).
function fe4Waves(source) {
  return [...source.matchAll(/await Promise\.all\(\[([\s\S]*?)\]\)/g)].map((m) =>
    [...m[1].matchAll(/\b((?:get|load)[A-Z]\w*)\(/g)].map((call) => call[1]),
  );
}
function fe4LoadersOutsideWaves(source) {
  return source.replace(/await Promise\.all\(\[[\s\S]*?\]\)/g, '').match(/\b(?:get|load)[A-Z]\w*\(/g) ?? [];
}
// A page's waves: exactly these loaders, in these waves, at most three each.
function fe4AssertWaves(tab, expected) {
  const waves = fe4Waves(fe4Source[tab]);
  assert.deepEqual(waves, expected, `${tab}: the loader waves (pool cap of 5: at most three queries per wave)`);
  for (const wave of waves) assert.ok(wave.length <= 3, `${tab}: a wave of ${wave.length} queries`);
  assert.deepEqual(fe4LoadersOutsideWaves(fe4Source[tab]), [], `${tab}: every loader runs inside a wave`);
}
// A table's header cells, in order, whatever their attributes.
const fe4Headers = (source) => [...source.matchAll(/<th\b[^>]*>([^<{]+)/g)].map((m) => m[1].trim()).filter(Boolean);
// Expressions that must appear in this order (cell wiring).
const fe4InOrder = (source, pieces) =>
  new RegExp(pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?'));

// Rendered pages: every analytics page with test-only loaders (scripts/
// fixtures/fe4-loaders.mjs, K3-shaped data, 'long' or 'empty'), rendered as
// the server sends it. The fixture loaders count how many run at once.
const fe4Compiled = compileAdminSources({
  name: 'analytics-pages',
  sources: [
    ...Object.values(FE4_PAGES),
    'src/components/analytics/AnalyticsHeader.tsx',
    'src/components/analytics/StalePicker.tsx',
  ],
  fakes: {
    'next/link': 'scripts/fakes/next-link.mjs',
    'src/lib/server/session.ts': 'scripts/fakes/session.mjs',
    'src/lib/server/admin-analytics.ts': 'scripts/fixtures/fe4-loaders.mjs',
  },
});
async function fe4Render(tab, mode, params) {
  globalThis.__adminCheck = {
    session: { sub: 'check-admin-sub', email: 'ops-admin@example.test', role: 'admin_readonly', groups: ['admin_readonly'] },
    fe4Mode: mode,
  };
  const { default: Page } = await fe4Compiled.load(FE4_PAGES[tab]);
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
  return { html, calls: globalThis.__adminCheck.fe4Calls };
}
const fe4Tags = (html) => [...html.matchAll(/data-item-tag=""[^>]*>(#\d+)</g)].map((m) => m[1]);
// Every chart on a rendered page titles both axes.
function fe4AssertChartsTitled(label, html) {
  const charts = html.split(/(?=<div[^>]*data-chart=")/).slice(1);
  for (const chart of charts) {
    const kind = chart.match(/data-chart="([^"]+)"/)[1];
    assert.match(chart, /data-axis-title="x"/, `${label}: a ${kind} chart titles its x axis`);
    assert.match(chart, /data-axis-title="y"/, `${label}: a ${kind} chart titles its y axis`);
  }
  return charts.length;
}
// The invariants every rendered analytics page keeps, long or empty, 8 or 26 weeks.
async function fe4AssertRendersCleanly(tab, extraParams = {}) {
  const out = {};
  for (const mode of ['long', 'empty']) {
    for (const weeks of ['8', '26']) {
      const { html, calls } = await fe4Render(tab, mode, { weeks, ...extraParams });
      const label = `${tab} (${mode}, ${weeks} weeks)`;
      assert.ok(calls.max <= 3, `${label}: at most three loaders run at once (saw ${calls.max})`);
      assert.doesNotMatch(html, /NaN|undefined|Infinity|\[object Object\]/, `${label}: no NaN, undefined or object text`);
      assert.doesNotMatch(html, /<main[\s>]/, `${label}: the console layout owns <main>; a page renders a <div> root`);
      assert.doesNotMatch(html, /style="[^"]*(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/, `${label}: inline colours come only from tokens`);
      fe4AssertChartsTitled(label, html);
      out[`${mode}-${weeks}`] = html;
    }
  }
  return out;
}
// ==== end shared helpers ====

// ==== S28 FE-4: header, tabs and pickers ====
{
  const { AnalyticsHeader, analyticsTabItems } = await fe4Compiled.load('src/components/analytics/AnalyticsHeader.tsx');
  const { StalePicker } = await fe4Compiled.load('src/components/analytics/StalePicker.tsx');
  assert.deepEqual(analyticsTabItems('employers', 13), [
    { label: 'Growth', href: '/analytics?weeks=13', active: false },
    { label: 'Funnels', href: '/analytics/funnels?weeks=13', active: false },
    { label: 'Employers', href: '/analytics/employers?weeks=13', active: true },
    { label: 'Ops health', href: '/analytics/ops?weeks=13', active: false },
  ], 'the four tabs keep the range; the fourth is "Ops health" (prototype)');
  const header = renderToStaticMarkup(createElement(AnalyticsHeader, { active: 'growth', weeks: 26, rangeHref: (weeks) => `/analytics?weeks=${weeks}&signups=new` }));
  assert.match(header, /<h1[^>]*>Analytics<\/h1>/);
  assert.match(fe4Flat(header), /Every item from the analytics list, grouped by the question it answers\. Tags show the list number\. Every chart labels both axes and every value\./);
  assert.match(header, /aria-label="Range"/);
  for (const [weeks, label] of [[8, 'Last 8 weeks'], [13, 'Last 13 weeks'], [26, 'Last 26 weeks']]) {
    assert.match(header, new RegExp(`href="/analytics\\?weeks=${weeks}&amp;signups=new"[^>]*>${label}<`), `the range offers ${label}`);
  }
  assert.match(header, /aria-current="page"[^>]*>Last 26 weeks</, 'the current range is marked');
  assert.match(header, /aria-label="Analytics sections"/);
  const stale = renderToStaticMarkup(createElement(StalePicker, { current: 30, hrefFor: (days) => `/analytics/employers?weeks=8&stale=${days}` }));
  assert.match(stale, /aria-label="Stale after"/);
  assert.deepEqual([...stale.matchAll(/>(\d+) days</g)].map((m) => m[1]), ['7', '14', '30']);
  assert.match(stale, /aria-current="page"[^>]*>30 days</);
  for (const path of ['src/components/analytics/RangePicker.tsx', 'src/components/analytics/StalePicker.tsx']) {
    assert.match(read(path), /href=\{hrefFor\([^)]*\)\}\s*prefetch=\{false\}/, `${path}: links never prefetch`);
  }
}
// ==== end header, tabs and pickers ====

// ==== S28 FE-4: Growth (/analytics) ====
{
  const page = fe4Source.growth;

  // T5: the waves come first, so the old page fails on what it loads (before any new file is read).
  fe4AssertWaves('growth', [
    ['getSignups', 'getJobsActivity', 'getMessageTraffic'],
    ['getAnalyticsTotals', 'loadPayingEmployers', 'getPayingWeekly'],
    ['getDigestAdoption', 'getDigestSends', 'getAcquisition'],
  ]);
  const panels = read('src/components/analytics/panels/growth.tsx');
  const delivery = read('src/components/analytics/DeliveryHealth.tsx');
  const payingList = read('src/components/analytics/PayingEmployersList.tsx');

  assert.match(page, /\) \{\n  const session = await requireAdminSession\(\);\n  const \{ weeks: weeksParam, signups: signupsParam \} = await searchParams;/, 'growth: the session gate comes before any read');
  assert.match(page, /searchParams\??:\s*Promise</, 'growth: searchParams is a Promise (Next 16)');
  assert.match(page, /const weeks = parseFunnelWeeks\(weeksParam\);/, 'growth: the K3.0 range (8 / 13 / 26 weeks) comes from ?weeks=');
  assert.match(page, /const signupsView = parseSignupsView\(signupsParam\);/, 'growth: the signups view comes from ?signups=');
  assert.match(page, /getSignups\(weeks\),\s*getJobsActivity\(weeks\),\s*getMessageTraffic\(weeks\)/, 'growth: the weekly series follow the range');
  assert.match(page, /loadPayingEmployers\(session\)/, 'growth: the paying list loads through its recorded loader');
  assert.doesNotMatch(page, /getPayingEmployers\(|getAdminDbPool|@\/lib\/server\/db['"]/, 'growth: nothing is read unrecorded or from the pool');
  assert.equal((page.match(/<StatTile /g) ?? []).length, 6, 'growth: the KPI strip keeps exactly six tiles');
  assert.match(page, /<StatTile label="Hires" /, 'growth: hires replace the filled-jobs snapshot');
  assert.doesNotMatch(page, /Filled jobs/, 'growth: no filled-jobs tile');
  assert.match(page, /\$\{formatCount\(newVerified\)\} verified`/, 'growth: the workers tile notes how many new workers verified');
  assert.match(page, /<AnalyticsHeader active="growth" weeks=\{weeks\} rangeHref=\{\(value\) => growthHref\(value, signupsView\)\} \/>/, 'growth: tabs and range picker; the range keeps the signups view');
  for (const kept of ['<JobsPostedPanel', '<ApplicationsPanel', '<DeliveryHealth', '<PayingEmployersList']) {
    assert.ok(page.includes(kept), `growth keeps ${kept.slice(1)}`);
  }
  assert.doesNotMatch(page, /<form|AdminActionsPanel/, 'growth is read-only');

  // #1: running totals (or new per week), workers and employers; verified workers in the table twin.
  assert.match(panels, /cumulativeSeries\(workersNew, totals\.totalWorkers\)/);
  assert.match(panels, /cumulativeSeries\(verifiedNew, totals\.totalVerifiedWorkers\)/, '#1: the verified running total ends at today\'s verified count');
  assert.match(panels, /label: 'Verified workers'/, '#1: verified workers stay in the table twin');
  assert.match(fe4Flat(panels), /title=\{title\} labels=\{labels\} series=\{series\} xTitle="Week starting" yTitle=\{cumulative \? 'Total signups' : 'New signups'\} partialLast/);
  assert.match(panels, /href=\{growthHref\(weeks, value\)\}/, '#1: the Total / New toggle keeps the range');
  // #13 is digest adoption, never an open rate (K3.1, D-A3).
  assert.match(panels, /title="Digest adoption"/);
  assert.doesNotMatch(panels, /open rate|opened/i, '#13: there is no email-open tracking');
  // #16 collects from this release: empty, labelled axes until the first row.
  assert.match(fe4Flat(panels), /chart\.empty \? \( <CollectingSince title="Signups per week by source" xTitle="Week since release" yTitle="Signups per week"/);
  assert.match(panels, /One line per source: shared links, campaign tags, referrals, direct\./);

  // Kept: delivery health and the paying list, restyled.
  assert.match(delivery, /<svg[^>]*aria-hidden/, 'delivery: the failure count carries an icon, never colour alone');
  assert.match(delivery, /failed or unconfirmed/, 'delivery failures are labelled honestly');
  assert.match(delivery, /percentOf\(channel\.failed, channel\.out/, 'delivery: the failure rate is a share of outbound messages');
  assert.match(payingList, /periodEndLabel\(row\)/, 'paying list: period-end copy comes from the shared formatter');
  assert.match(payingList, /<Badge tone=\{STATUS_TONE\[row\.status\] \?\? 'neutral'\}>/, 'paying list: status is a Badge with its words');

  const rendered = await fe4AssertRendersCleanly('growth');
  for (const [view, html] of Object.entries(rendered)) {
    assert.deepEqual(fe4Tags(html), ['#1', '#2', '#13', '#16'], `growth (${view}): the list tags of the tab, in order`);
  }
  assert.match(rendered['empty-8'], /data-chart="collecting-since"/, '#16 with no rows: the collecting-since panel');
  assert.match(rendered['empty-8'], /No data yet · collecting since [^<]+</, '#16: the release label (jale sets it at release)');
  assert.doesNotMatch(rendered['long-26'], /data-chart="collecting-since"/, '#16 with rows: a real chart');
}
// ==== end Growth ====

// ==== S28 FE-4: Funnels (/analytics/funnels) ====
{
  const page = fe4Source.funnels;

  // T5: the waves come first, so the old page fails on what it loads (before any new file is read).
  fe4AssertWaves('funnels', [
    ['getOnboardingCohorts', 'getOnboardingStalled', 'getOnboardingSteps'],
    ['getIdentityFunnel', 'getReferralFunnel', 'getOnboardingRestarts'],
    ['getOperatorResets', 'getJobViewFunnel', 'getMatchToApply'],
  ]);
  const panels = read('src/components/analytics/panels/funnels.tsx');
  const cohortTable = read('src/components/analytics/CohortTable.tsx');
  const stalledList = read('src/components/analytics/StalledList.tsx');
  const restarts = read('src/components/analytics/RestartsByStep.tsx');
  const resets = read('src/components/analytics/OperatorResets.tsx');

  assert.match(page, /\) \{\n  await requireAdminSession\(\);\n  const \{ weeks: weeksParam, door: doorParam \} = await searchParams;/, 'funnels: the session gate comes before any read');
  assert.match(page, /searchParams\??:\s*Promise</);
  assert.match(page, /const weeks = parseFunnelWeeks\(weeksParam\);\n  const door = parseFunnelDoor\(doorParam\);/);
  assert.match(page, /getOnboardingSteps\(weeks, door\)/, '#14 follows the door picker');
  assert.equal((page.match(/<StatTile /g) ?? []).length, 4, 'funnels: four KPI tiles');
  assert.match(page, /showCode=\{door === 'whatsapp'\}/, 'the Code column appears only for the WhatsApp door');
  assert.match(page, /href=\{funnelsHref\(weeks, value\)\}/, 'the door links keep the range');
  assert.match(page, /rangeHref=\{\(value\) => funnelsHref\(value, door\)\}/, 'the range links keep the door');
  assert.match(page, /whatsappStages\(cohortRows, weeks, now\)/, '#12 is the WhatsApp door\'s cohort funnel whatever the door picker says');
  for (const kept of ['<StalledList', '<CohortTable', '<RestartsByStep', '<OperatorResets']) {
    assert.ok(page.includes(kept), `funnels keeps ${kept.slice(1)}`);
  }
  assert.doesNotMatch(page, /<form|AdminActionsPanel/, 'funnels is read-only');

  // Funnels print "% · count" (FunnelChart); #15 links the lockouts; #21 explains the snapshots.
  assert.match(panels, /<FunnelChart /);
  assert.match(panels, /href="\/inbox\?tab=lockouts" prefetch=\{false\}/, '#15 links to the lockouts tab of the Inbox');
  assert.match(panels, /See locked-out workers →/);
  assert.match(panels, /referralNote\(result\.snapshotsSince\)/, '#21 says it is kept as daily snapshots');
  assert.match(panels, /yTitle="Views that apply \(%\)"/, '#17 axis title');
  assert.match(panels, /yTitle="Matches that apply \(%\)"/, '#20 axis title');
  assert.match(panels, /<CollectingSince title=\{emptyTitle\} xTitle="Week since release"/, '#17 and #20 collect from this release');

  // Kept components, restyled: same columns, same wiring, same copy.
  assert.deepEqual(fe4Headers(cohortTable), ['Week', 'Started', 'In progress', 'Abandoned', 'Declined'], 'cohort table: fixed columns (the share columns are mapped)');
  assert.match(cohortTable, /\{shares\.map\(\(column\) => \(\s*<th key=\{column\.key\} className=\{TH_NUM\}>\{column\.header\}<\/th>/);
  assert.match(cohortTable, />settling</, 'still-moving weeks are labelled');
  assert.match(cohortTable, /<TableScroll label="Weekly cohorts table">/, 'the cohort table scrolls in its own region');
  assert.match(stalledList, /orientation="horizontal"/, 'stuck now is a D11 bar chart');
  assert.match(stalledList, /No one is stuck right now\./);
  assert.deepEqual(fe4Headers(restarts), ['Step', 'Reached', 'Started over', 'Went back', 'Presses', 'All steps']);
  assert.match(restarts, fe4InOrder(restarts, ['{formatCount(row.reached)}', '{row.startedOver}', '{row.wentBack}', '{formatCount(row.presses)}']));
  assert.match(restarts, fe4InOrder(restarts, ['{formatCount(totals.reached)}', '{totals.startedOver}', '{totals.wentBack}', '{formatCount(totals.presses)}']), 'the total row is the SQL all-steps row');
  assert.match(restarts, /const byWeek = restartWeeks\(rows, door, weeks, now\);/, 'every week of the window, zero-filled');
  assert.match(restarts, /series = startOver \? \[startedOver, wentBack\] : \[wentBack\]/, 'no start-over line on the web');
  assert.match(restarts, /No one started over or went back in these weeks\./);
  assert.match(restarts, /No start over on the web/);
  assert.deepEqual(fe4Headers(resets), ['Week', 'Reason', 'Workers', 'Resets']);
  assert.match(resets, /const tableRows = resetTableRows\(rows, now\);/, 'bulk runs are left out of the table');
  assert.match(resets, /\{bulkNote === null \? 'No operator resets in these weeks\.' : 'No other operator resets in these weeks\.'\}/);
  assert.match(resets, /\{bulkNote === null \? null : <p[^>]*>\{bulkNote\}<\/p>\}/, 'bulk runs are listed under the table, also when it is empty');

  // The old footnote, now one line per panel: every fact is still said, none of the old wrong claims.
  const funnelsCopy = fe4Flat(cohortTable + restarts + resets);
  for (const [pattern, point] of [
    [/Reached counts the workers who were at a step in these weeks: they arrived there, or started over or went back from it\./, 'what Reached counts'],
    [/All steps and the weekly chart count each worker once, so the steps can add up to more; Presses count every press/, 'workers once across steps, presses add up'],
    [/a reason used for 10 or more workers within an hour is a bulk run, left out of the counts and listed under the table\./, 'the bulk rule'],
    [/Reasons are typed by operators; long numbers, emails and IDs are hidden\./, 'reasons are masked'],
    [/Workers reset by an operator and accounts from the retired web bypass are left out, so Verified here differs from the verified sign-ups on the Growth tab\./, 'who the cohorts leave out'],
    [/Weeks before the onboarding funnel launched show no starters\./, 'weeks before launch'],
  ]) {
    assert.match(funnelsCopy, pattern, `the funnels copy still says: ${point}`);
  }
  for (const [pattern, point] of [
    [/can pass 100%/, 'that a share can pass 100%'],
    [/Presses and the chart count every press/, 'that the chart counts presses'],
    [/Runs of 4 or more digits in a reason are masked\./, 'the old mask rule'],
    [/Reasons are typed by operators; long numbers are hidden\./, 'the old mask sentence'],
  ]) {
    assert.doesNotMatch(funnelsCopy, pattern, `the funnels copy no longer claims ${point}`);
  }

  const rendered = await fe4AssertRendersCleanly('funnels');
  for (const [view, html] of Object.entries(rendered)) {
    assert.match(html, /More about these numbers/, `funnels (${view}): the notes are offered`);
  }
  assert.match(rendered['long-8'], /data-panel-note="">[\d,]+ declined the terms in these weeks\.<\/p>/, 'cohorts: N declined the terms in these weeks, with its count');
  assert.match(rendered['empty-8'], /data-panel-note="">0 declined the terms in these weeks\.<\/p>/, 'cohorts: a count of 0 is still said');
  for (const sentence of [
    'Start over and back counts workers by the step they left with the start over command (WhatsApp only) or back; voice-note retry loops and system moves do not count as going back.',
    'Workers reset by an operator lose their onboarding history, so their earlier restarts are not counted.',
    'Start over and back counts moves made since the last operator reset of each worker.',
    'On All, the start-over share is of every worker who was at the step, web included.',
  ]) {
    assert.ok(rendered['long-8'].includes(`data-panel-note="">${sentence}</p>`), `restarts: a note says: ${sentence.slice(0, 48)}`);
  }
  assert.equal(
    (rendered['long-8'].match(/data-panel-note="">[\d,]+ declined/g) ?? []).length,
    1,
    'cohorts: the declined note appears once',
  );
  for (const [view, html] of Object.entries(rendered)) {
    assert.deepEqual(fe4Tags(html), ['#14', '#15', '#12', '#21', '#17', '#20'], `funnels (${view}): the list tags of the tab, in order`);
  }
  assert.equal((rendered['empty-8'].match(/data-chart="collecting-since"/g) ?? []).length, 2, '#17 and #20 with no rows: collecting since');
  assert.match(rendered['long-8'], /100% · 1,000/, '#14: "% · count" on the first step');
  for (const door of ['whatsapp', 'web']) {
    const { html } = await fe4Render('funnels', 'long', { weeks: '13', door });
    assert.match(html, new RegExp(`aria-current="page"[^>]*>${door === 'web' ? 'Web' : 'WhatsApp'}<`), `the ${door} door is marked current`);
  }
}
// ==== end Funnels ====

// ==== S28 FE-4: Employers (/analytics/employers) ====
{
  const page = fe4Source.employers;

  // T5: the waves come first, so the old page fails on what it loads (before any new file is read).
  fe4AssertWaves('employers', [
    ['getEmployerWeekly', 'loadSlowestEmployers', 'loadStaleJobs'],
    ['getDigestAdoption', 'getDigestSends', 'getTemplateReuse'],
    ['getAnalyticsTotals'],
  ]);
  const panels = read('src/components/analytics/panels/employers.tsx');
  const weeklyTable = read('src/components/analytics/EmployerWeeklyTable.tsx');
  const slowest = read('src/components/analytics/SlowestEmployers.tsx');
  const staleList = read('src/components/analytics/StaleJobsList.tsx');
  const digestCard = read('src/components/analytics/DigestEmails.tsx');
  const stalePicker = read('src/components/analytics/StalePicker.tsx');

  assert.match(page, /\) \{\n  const session = await requireAdminSession\(\);\n  const \{ weeks: weeksParam, stale: staleParam \} = await searchParams;/, 'employers: the session gate comes before any read');
  assert.match(page, /const weeks = parseFunnelWeeks\(weeksParam\);\n  const staleDays = parseStaleDays\(staleParam\);/, '#4: ?stale=7|14|30 (default 14)');
  // The two lists name employers: each loads through its recorded loader.
  assert.match(page, /loadSlowestEmployers\(session, weeks\)/);
  assert.match(page, /loadStaleJobs\(session, staleDays\)/, '#4: the picked window reaches the recorded loader');
  assert.doesNotMatch(page, /getSlowestEmployers\(|getStaleJobs\(|getAdminDbPool|@\/lib\/server\/db['"]/, 'employers: nothing is read unrecorded or from the pool');
  assert.match(page, /const \{ weekly, summary \} = splitEmployerWeekly\(weeklyRows\);/, 'the tiles read the SQL whole-window row');
  for (const [pattern, point] of [
    [/<StatTile label="First response" value=\{formatDuration\(summary\.firstResponseP50Hours\)\} hint=\{firstResponseNote\(summary\)\} \/>/, 'First response'],
    [/<StatTile label="Reply time" value=\{formatDuration\(summary\.replyP50Hours\)\} hint=\{replyNote\(summary\)\} \/>/, 'Reply time'],
    [/<StatTile label="Time to hire" value=\{formatDays\(summary\.timeToHireP50Days\)\} hint=\{hiresNote\(summary\)\} \/>/, 'Time to hire'],
    [/<StatTile label="Stale jobs" value=\{formatCount\(staleJobs\.length\)\} hint=\{staleJobsNote\(summary\.activeJobs\)\} \/>/, 'Stale jobs'],
  ]) {
    assert.match(page, pattern, `the ${point} tile is wired to the window summary`);
  }
  assert.equal((page.match(/<StatTile /g) ?? []).length, 4, 'employers: four KPI tiles');
  assert.match(page, /rangeHref=\{\(value\) => employersHref\(value, staleDays\)\}/, 'the range keeps the stale window');
  for (const kept of ['<EmployerWeeklyTable rows={weeklyTableRows(weekly, now)}', '<SlowestEmployers rows={slowest}', '<DigestEmails adoption={adoption} sends={digest} now={now}', '<StaleJobsPanel tag="#4" jobs={staleJobs} days={staleDays}']) {
    assert.ok(page.includes(kept), `employers keeps ${kept.split(' ')[0].slice(1)}`);
  }
  assert.doesNotMatch(page, /<form|AdminActionsPanel/, 'employers is read-only');

  // #3, #4, #8, #18
  assert.match(panels, /A job counts as "filled" only when every opening is hired, so most jobs with hires are not "filled"\./, '#3 keeps the filled explanation');
  assert.match(panels, /<StalePicker current=\{days\} hrefFor=\{\(value\) => employersHref\(weeks, value\)\} \/>/, '#4: the stale picker keeps the range');
  assert.match(stalePicker, /STALE_OPTIONS: readonly StaleDays\[\] = \[7, 14, 30\]/);
  assert.match(stalePicker, /Stale after/);
  assert.match(panels, /note=\{staleNote\(jobs\.length\)\}/, '#4: "N open jobs with no employer action"');
  assert.match(panels, /note="median from application to first employer response"/, '#8 headline');
  assert.match(panels, /yTitle="Jobs from a template \(%\)"/, '#18 axis title');

  // Kept components, restyled: same columns, same wiring, same copy.
  assert.deepEqual(fe4Headers(weeklyTable), ['Week', 'Applications', 'Answered', 'Unanswered 7d', 'First response (p50 / p75)', 'Worker messages', 'Reply (p50 / p75)', 'Hires', 'Time to hire']);
  assert.match(weeklyTable, /\{answeredLabel\(row\)\}/, 'Answered shows how many answers have no time');
  assert.match(weeklyTable, /title="Under 14 days old: unanswered counts are not final yet"/);
  assert.match(weeklyTable, />approx\.</, 'weeks with approximate hires are marked');
  assert.deepEqual(fe4Headers(slowest), ['Employer', 'Applications', 'Unanswered 7d', 'Median first response', 'Active jobs']);
  assert.match(slowest, /No employer has 3\+ applications in these weeks\./);
  assert.match(slowest, /\{employerLabel\(row\.displayName, row\.employerId\)\}/, 'employer names use the shared label');
  assert.deepEqual(fe4Headers(staleList), ['Job', 'Employer', 'Idle', 'Waiting applicants', 'Last application', 'Posted']);
  assert.match(staleList, /firstWithRest\(rows, STALE_JOBS_SHOWN\)/, 'the list shows exactly the rows the loader recorded');
  assert.match(staleList, /No active job has gone \{days\}\+ days without employer activity\./);
  assert.match(staleList, /and \{formatCount\(more\)\} more/);
  assert.match(staleList, /isIdleSincePosting\(job\) \? <span[^>]*>since posting<\/span> : null/);
  assert.deepEqual(fe4Headers(digestCard), ['Week', 'Emailed', 'Sent', 'Failed', 'Unknown', 'Still sending', 'Employers reached', 'These weeks']);
  assert.match(digestCard, /\{adoptionLine\(adoption\)\}/, 'the adoption line always shows');
  assert.match(digestCard, /No digest emails in these weeks\./);

  // The old footnotes, now at most two sentences per panel: the sentences that change how a number is read.
  const employersCopy = fe4Flat(panels + weeklyTable + digestCard);
  for (const [pattern, point] of [
    [/What counts as an employer action:/, 'what counts as an employer action'],
    [/Status changes are recorded since Oct 2, 2026\./, 'status changes recorded since Oct 2'],
    [/Dropdown status changes before Oct 2 have no time, so they count as answered but not in the medians\./, 'untimed answers'],
    [/Employer actions taken only through the status dropdown before Oct 2 were not recorded, so some jobs show as idle since posting\./, 'idle since posting'],
    [/Time to hire includes the worker completing their details\./, 'time to hire'],
    [/a run of consecutive messages from a worker counts once, and conversations closed without a reply are left out\./, 'what a worker message is'],
    [/Unknown means the send timed out and may have arrived \(it is never retried\)/, 'what Unknown means'],
    [/Bounces and spam complaints switch the digest off for that employer but do not show as failures\./, 'bounces are not failures'],
    [/Failed means the send gave up after 5 attempts; .*Still sending means queued or waiting to retry\./, 'Failed and Still sending'],
  ]) {
    assert.match(employersCopy, pattern, `the employers copy still says: ${point}`);
  }
  for (const [label, source] of [['#4', panels], ['week by week', weeklyTable], ['digest', digestCard]]) {
    for (const match of source.matchAll(/howCounted=(?:\{'([^']*)'\}|"([^"]*)")/g)) {
      const sentences = (match[1] ?? match[2]).split(/(?<=\.)\s+(?=[A-Z])/);
      assert.ok(sentences.length <= 2, `${label}: a "how it's counted" line is at most two sentences (saw ${sentences.length})`);
    }
  }

  const rendered = await fe4AssertRendersCleanly('employers');
  for (const [view, html] of Object.entries(rendered)) {
    assert.match(html, /More about these numbers/, `employers (${view}): the notes are offered`);
  }
  for (const [point, sentence] of [
    ['#4', 'A job that was paused and reopened counts its idle days from the last employer action, which can be before the pause.'],
    ['week by week', 'Hires from before hire times were recorded are marked approx.: they count as answered but not timed, and their time to hire is approximate.'],
    ['week by week', 'The unanswered shares count only applications and worker messages at least 7 days old.'],
    ['week by week', 'Weeks marked settling are less than 14 days old, so their unanswered counts are not final; a late answer can still change an older week too.'],
    ['week by week', 'Deleted jobs drop out of every figure.'],
    ['week by week', 'Test employer accounts are left out.'],
    ['digest', 'Applicant digest emails launched on Aug 23, 2026, so earlier weeks are empty.'],
    ['digest', 'An employer with the digest on is emailed at most once a day, only on days with new applicants, and only when they have an email address.'],
    ['digest', 'Digest emails count by the week they were queued.'],
    ['digest', 'Employers reached counts employers with at least one digest sent.'],
    ['digest', 'Who has the digest on, and their email address, is as of now; digest emails of deleted employers drop out.'],
  ]) {
    assert.ok(rendered['long-8'].includes(`data-panel-note="">${sentence}</p>`), `employers (${point}): a note says: ${sentence.slice(0, 48)}`);
  }
  for (const [view, html] of Object.entries(rendered)) {
    assert.deepEqual(fe4Tags(html), ['#3', '#8', '#4', '#18'], `employers (${view}): the list tags of the tab, in order`);
  }
  assert.match(rendered['empty-8'], /data-chart="collecting-since"/, '#18 with no rows: collecting since');
  for (const stale of ['7', '30']) {
    const { html, calls } = await fe4Render('employers', 'long', { weeks: '8', stale });
    assert.ok(calls.names.includes('loadStaleJobs'));
    assert.match(html, new RegExp(`aria-current="page"[^>]*>${stale} days<`), `the ${stale}-day window is marked current`);
  }
}
// ==== end Employers ====

// ==== S28 FE-4: Ops health (/analytics/ops) ====
{
  const page = fe4Source.ops;

  // T5: the waves come first, so the old page fails on what it loads (before any new file is read).
  fe4AssertWaves('ops', [
    ['getMessageBacklog', 'getMessageFailures', 'getBillingInboxNow'],
    ['getVoiceExtraction', 'getTrustExtraction', 'getBillingInbox'],
    ['getCaseAging', 'getCaseResolution', 'getResetReasons'],
    ['getDlqDepth', 'getRankingFreshness'],
  ]);
  const panels = read('src/components/analytics/panels/ops.tsx');
  const backlog = read('src/components/analytics/MessageBacklog.tsx');
  const failures = read('src/components/analytics/MessageFailures.tsx');
  const voice = read('src/components/analytics/VoiceExtraction.tsx');
  const trust = read('src/components/analytics/TrustExtraction.tsx');
  const billing = read('src/components/analytics/BillingInbox.tsx');
  const opsHelpers = read('src/lib/ops-health.ts');

  assert.match(page, /\) \{\n  await requireAdminSession\(\);\n  const \{ weeks: weeksParam \} = await searchParams;\n  const weeks = parseFunnelWeeks\(weeksParam\);/, 'ops: the session gate comes before any read');
  assert.match(page, /getResetReasons\(30\)/, '#5 covers the last 30 days');
  assert.match(page, /const failures = splitMessageFailures\(failureRows\);\n  const voice = splitVoiceExtraction\(voiceRows\);\n  const trust = splitTrustExtraction\(trustRows\);\n  const billing = splitBillingInbox\(billingRows\);/, 'tiles and sections read the SQL rows through the pure splitters');
  assert.equal((page.match(/<StatTile /g) ?? []).length, 4, 'ops: four KPI tiles');
  for (const label of ['Messages stuck now', 'Billing events stuck', 'Message failure rate', 'Voice extraction success']) {
    assert.ok(page.includes(`<StatTile label="${label}"`), `ops tile: ${label}`);
  }
  assert.match(page, /<StatTile label="Billing events stuck" value=\{formatCount\(billingStuck\(inboxNow\)\)\} hint=\{billingStuckNote\(inboxNow, now\)\} \/>/, 'the stuck tile stays the live one-hour figure');
  assert.match(page, /<ResetReasonsPanel tag="#5" linkTag="#7" rows=\{resetReasons\} \/>/, '#5 with the #7 link');
  assert.match(fe4Flat(page), /\{ tag: '#9', label: 'Billing webhooks failed, last 24 hours'[\s\S]*\{ tag: '#11', label: 'Messages queued · dead-lettered'[\s\S]*\{ tag: '#19', label: 'Candidate rankings older than 24h'/, 'the pipelines strip: #9, #11, #19');
  assert.match(page, /The range changes the weekly sections and the two rate tiles; stuck counts and the pipelines are always live\./, 'the page says what the range changes');
  for (const kept of ['<MessageBacklog lanes={backlog} />', '<MessageFailures failures={failures} now={now} />', '<VoiceExtraction voice={voice} now={now} />', '<TrustExtraction trust={trust} now={now} />', '<BillingInbox billing={billing} inbox={inboxNow} now={now} />']) {
    assert.ok(page.includes(kept), `ops keeps ${kept.split(' ')[0].slice(1)}`);
  }
  assert.doesNotMatch(page, /<form|AdminActionsPanel/, 'ops is read-only');
  assert.match(fe4Flat(page), /<CaseAgingPanel[^>]*\/> <\/div> <div className="min-w-0"> <ResetReasonsPanel[^>]*\/> <\/div> <div className="min-w-0 lg:col-span-2"> <CaseResolutionPanel tag="#6" weeks=\{caseResolution\} \/> <\/div> <div className="min-w-0 lg:col-span-2"> <ExtractionPanel/, 'ops: the two-series 26-week resolution chart and the extraction chart take the full row on wide screens; the two short panels pair up above them');

  // #7, #9, #10, #11
  assert.match(panels, /href="\/inbox\?tab=lockouts" prefetch=\{false\}/, '#7 opens the verification records in the Inbox');
  assert.match(fe4Flat(panels), /Open a verification record \(<ItemTag tag=\{linkTag\} \/>: attempts and timeline\) →/);
  assert.match(panels, /chart\.yMin === 80 \? 'The vertical axis starts at 80% so week-to-week changes are visible\.' : undefined/, '#10: the 80% floor always comes with its caption');
  assert.match(opsHelpers, /Couldn't read right now/, '#11: an unreadable dead-letter queue says so');
  assert.match(opsHelpers, /value: formatCount\(inbox\.failedLast24h\)/, '#9 reads the 24-hour failed count');

  // Failures: one small-multiple row per lane, each lane on its fixed chart token.
  assert.match(failures, /<StackedLines/);
  assert.match(failures, /const chart = failureChart\(failures, now\);/);
  assert.match(opsHelpers, /reply: 'chart-1',\n  admin: 'chart-2',\n  worker_notification: 'chart-3',\n  employer_invite: 'chart-4',\n  employer_freeform: 'chart-5',\n  job_alert: 'chart-6',/, 'the six lanes keep chart-1…6 in LANES order');

  // Kept components, restyled: same columns, same wiring, same empty states.
  assert.deepEqual(fe4Headers(backlog), ['Lane', 'Under 1 h', '1–24 h', '24–48 h', 'Stuck']);
  assert.match(backlog, fe4InOrder(backlog, ['{formatCount(row.openUnder1h)}', '{formatCount(row.open1To24h)}', '{formatCount(row.open24To48h)}', '{formatCount(row.stuck)}']));
  assert.match(backlog, /No messages waiting\./);
  assert.match(backlog, /\{row\.stuckAfter\}/, 'each lane shows its retry window');
  assert.deepEqual(fe4Headers(failures), ['Week', 'These weeks']);
  assert.match(failures, /<th key=\{lane\.lane\} className=\{TH_NUM\}>\{lane\.label\}<\/th>/, 'one failed / created column per lane');
  assert.match(failures, /\{failedOfCreated\(cell\)\}/);
  assert.match(failures, /No messages created in these weeks\./);
  assert.deepEqual(fe4Headers(voice), ['Week', 'Voice notes', 'Usable', 'Failed', 'Top cause', 'Field']);
  assert.match(voice, fe4InOrder(voice, ['{formatCount(row.processed)}', '{formatCount(row.usable)}', '{formatCount(row.failed)}', '{topCauseLabel(row)}']));
  assert.match(voice, /No voice notes in these weeks\./);
  assert.match(voice, /No failed extractions in these weeks\./);
  assert.match(voice, /wholePercent\(v, voice\.window\.failed\)/, "each cause's share is of the failures");
  assert.deepEqual(fe4Headers(trust), ['Week', 'Version', 'Extractions', 'Failed', 'Not enough detail', 'Avg sections of 5']);
  assert.match(trust, /No trust extractions in these weeks\./);
  assert.deepEqual(fe4Headers(billing), ['Week', 'Received', 'Processed', 'Skipped', 'Failed', 'Retried', 'Payment-failed invoices']);
  assert.match(billing, /<strong>Right now:<\/strong> \{billingLiveLine\(inbox, now\)\}/);
  assert.match(billing, /No billing events in these weeks\./);
  assert.match(billing, /No skipped events in these weeks\./);

  // The old footnote, sentence by sentence: the sentences that change how a number reads are the
  // panel's one-liner (at most two); every other sentence is a note under "More about these numbers".
  const opsCopy = fe4Flat(backlog + failures + voice + trust + billing);
  for (const [pattern, point] of [
    [/WhatsApp replies 30 min, Admin replies 10 min, Worker notifications 24 h, Employer invites and Employer free-text messages 30 min, Job alerts \(old lane\) 30 min\./, 'the lane retry windows'],
    [/Open means created in the last 48 hours and not sent yet: waiting, retrying, or in flight\./, 'what open means'],
    [/WhatsApp replies are retried only while their incoming message is redelivered \(about 30 minutes\); after that they are stranded\./, 'stranded replies'],
    [/Worker notifications can legitimately wait up to 48 hours for a message template to be approved; the 24-hour mark matches the existing backlog alarm\./, 'worker notifications can wait'],
    [/After 48 hours nothing retries a message, so anything still unsent counts as gave up\./, 'the 48-hour horizon'],
    [/Gave up also covers the last of 5 attempts failing, a send that ended with an unknown result, and any failed worker notification \(an expired template wait fails it after fewer attempts\)\./, 'what else gave up means'],
    [/A delivery failure was sent, but Twilio reported it failed or undelivered\./, 'what a delivery failure is'],
    [/Failure rate = \(gave up \+ delivery failures\) ÷ messages created, by the week a message was created\./, 'the failure rate'],
    [/Free-text employer messages record delivery failures on the conversation, not in this lane; the message delivery panel on the Growth tab counts them\./, 'free-text failures are counted elsewhere'],
    [/Deleting a job deletes its employer-message history\./, 'job deletion'],
    [/Job alerts now go out as worker notifications; only the old job-alert lane is dormant, and it shows only when it has messages\./, 'the dormant lane'],
    [/Weeks marked so far are still in progress, and messages that are still open can still add failures to their week\./, 'what so far means'],
    [/Voice figures count only voice notes that produced a row, as attempts: a note processed twice counts twice, and a pipeline crash or timeout leaves no row, so that note is not counted\./, 'voice counts attempts'],
    [/Test profiles are left out of the voice figures\./, 'test profiles (voice only)'],
    [/Failure causes are recorded only since migration 115 was applied; failed rows from before then show as Cause not recorded\./, 'causes since 115'],
    [/Pipeline error also includes AI calls that timed out after 60 seconds and, occasionally, an extra row written after a successful save\./, 'pipeline error'],
    [/Field completeness counts a field as found when it has a value with confidence 0\.75 or higher, the threshold onboarding uses\./, 'the completeness threshold'],
    [/Not enough detail means the answers had too little in them to send to the AI; average sections counts how many of the five \(skills, tools, experience, safety, notable\) came back non-empty\./, 'trust: not enough detail and sections'],
    [/Billing stuck means received but never claimed, or the 5-minute processing claim expired\./, 'billing stuck'],
    [/Billing events are retried for about 20 minutes; any still stuck or failed after an hour have been dead-lettered and can be redriven from the queue for 14 days\./, 'billing retries and the 14-day queue'],
    [/Older ones have left the queue and must be resent from Stripe\./, 'older billing events are resent from Stripe'],
  ]) {
    assert.match(opsCopy, pattern, `the ops copy still says: ${point}`);
  }
  for (const [pattern, point] of [
    [/Test profiles are left out\./, 'a page-wide test-profile claim'],
    [/nothing sends job alerts/, 'that job alerts stopped'],
    [/will retry/, 'that every failed billing event will be retried'],
    [/failed, retrying/, 'that every failed billing event is still retried'],
    [/dead-lettered and need a manual redrive\./, 'that every dead-lettered billing event can be redriven'],
    [/Open means not sent yet, still retrying, or in flight\./, 'an open definition without the 48-hour horizon'],
  ]) {
    assert.doesNotMatch(opsCopy, pattern, `the ops copy no longer claims ${point}`);
  }
  // A one-liner is at most two sentences, whether written inline or as a *_COUNTED constant.
  for (const [label, source] of [['panels', panels], ['backlog', backlog], ['failures', failures], ['voice', voice], ['trust', trust], ['billing', billing]]) {
    const lines = [
      ...[...source.matchAll(/howCounted=(?:\{'([^']*)'\}|"([^"]*)")/g)].map((m) => m[1] ?? m[2]),
      ...[...source.matchAll(/const \w+_COUNTED =\s*'([^']*)';/g)].map((m) => m[1]),
    ];
    for (const line of lines) {
      const sentences = line.split(/(?<=\.)\s+(?=[A-Z])/);
      assert.ok(sentences.length <= 2, `${label}: a "how it's counted" line is at most two sentences (saw ${sentences.length})`);
    }
  }

  const rendered = await fe4AssertRendersCleanly('ops');
  for (const [view, html] of Object.entries(rendered)) {
    assert.deepEqual(fe4Tags(html), ['#6', '#5', '#7', '#6', '#10', '#9', '#11', '#19'], `ops (${view}): the list tags of the tab, in order`);
    assert.match(html, /More about these numbers/, `ops (${view}): the notes are offered`);
    for (const [point, sentence] of [
      ['backlog', 'WhatsApp replies are retried only while their incoming message is redelivered (about 30 minutes); after that they are stranded.'],
      ['backlog', 'Worker notifications can legitimately wait up to 48 hours for a message template to be approved; the 24-hour mark matches the existing backlog alarm.'],
      ['failures', 'Gave up also covers the last of 5 attempts failing, a send that ended with an unknown result, and any failed worker notification (an expired template wait fails it after fewer attempts).'],
      ['failures', 'A delivery failure was sent, but Twilio reported it failed or undelivered.'],
      ['failures', 'Free-text employer messages record delivery failures on the conversation, not in this lane; the message delivery panel on the Growth tab counts them.'],
      ['failures', 'Deleting a job deletes its employer-message history.'],
      ['failures', 'Job alerts now go out as worker notifications; only the old job-alert lane is dormant, and it shows only when it has messages.'],
      ['failures', 'Weeks marked so far are still in progress, and messages that are still open can still add failures to their week.'],
      ['billing', 'Older ones have left the queue and must be resent from Stripe.'],
    ]) {
      assert.ok(html.includes(`data-panel-note="">${sentence}</p>`), `ops (${view}, ${point}): a note says: ${sentence.slice(0, 48)}`);
    }
  }
  assert.match(rendered['empty-8'], /Dead-letter queues: Couldn&#x27;t read right now|Dead-letter queues: Couldn't read right now/, '#11: no dead-letter reading never reads as zero');
  assert.match(rendered['long-8'], /The vertical axis starts at 80% so week-to-week changes are visible\./, '#10 above 80% every week: the floor and its caption');
  assert.doesNotMatch(rendered['empty-8'], /The vertical axis starts at 80%/, '#10 with no weeks: no floor, no caption');
}
// ==== end Ops ====

// ==== S28 FE-4: all 21 items, across the four tabs ====
{
  const ITEMS = [
    [1, 'growth'], [2, 'growth'], [13, 'growth'], [16, 'growth'],
    [12, 'funnels'], [14, 'funnels'], [15, 'funnels'], [17, 'funnels'], [20, 'funnels'], [21, 'funnels'],
    [3, 'employers'], [4, 'employers'], [8, 'employers'], [18, 'employers'],
    [5, 'ops'], [6, 'ops'], [7, 'ops'], [9, 'ops'], [10, 'ops'], [11, 'ops'], [19, 'ops'],
  ];
  assert.deepEqual(ITEMS.map(([n]) => n).sort((a, b) => a - b), Array.from({ length: 21 }, (_, i) => i + 1), 'every list item, once');
  for (const [n, tab] of ITEMS) {
    assert.match(fe4Source[tab], new RegExp(`(?:tag|linkTag)="#${n}"|tag: '#${n}'`), `#${n} is tagged on the ${tab} tab`);
  }
}
// ==== end all 21 items ====

// ==== S28 FE-4: every analytics file (D11 gates) ====
{
  // The legacy charts and tiles are gone; their pages use the D11 components.
  for (const gone of ['TrendChart', 'ColumnChart', 'KpiTile', 'FunnelBars', 'AnalyticsTabs']) {
    assert.equal(existsSync(resolve(root, `src/components/analytics/${gone}.tsx`)), false, `${gone} was replaced by the D11 components`);
  }
  const files = readdirSync(resolve(root, 'src/components/analytics'), { recursive: true })
    .filter((entry) => /\.tsx?$/.test(entry))
    .map((entry) => `src/components/analytics/${entry}`);
  assert.ok(files.length >= 30, `the analytics component scan found ${files.length} files`);
  const helpers = ['chart-geometry', 'analytics-format', 'funnel', 'employer-health', 'ops-health', 'digest', 'restarts'].map((name) => `src/lib/${name}.ts`);
  // Old CSS class names lose to Tailwind utilities while legacy.css is loaded
  // (unlayered), so new analytics markup never uses one.
  const LEGACY = new Set([
    'card', 'button', 'badge', 'pill', 'muted', 'stack', 'stack-gap', 'hero', 'panel', 'meta', 'kpi', 'num', 'list', 'row', 'wrap', 'name', 'plan', 'period', 'cancels', 'positive', 'tick',
    'table-scroll', 'data-table', 'cohort-table', 'cohort-card', 'cohort-settling', 'kpi-strip', 'funnel-kpis', 'kpi-label', 'kpi-value', 'kpi-note', 'range-picker', 'analytics-tabs', 'analytics-hero', 'analytics-bottom',
    'funnel-pickers', 'ops-picker', 'chart-card', 'chart-head', 'chart-legend', 'chart-table', 'chart-tools', 'chart-svg', 'legend-key', 'axis-date', 'end-label', 'digest-adoption',
    'employer-approx', 'employer-note', 'employer-more', 'list-rows', 'list-row', 'ops-live', 'ops-sub', 'ops-stuck', 'ops-cause', 'ops-model', 'ops-code', 'restarts-note', 'restarts-reason',
    'funnel-bars', 'funnel-row', 'funnel-meta', 'funnel-label', 'funnel-track', 'funnel-fill', 'stalled', 'delivery-rows', 'delivery-row', 'delivery-meta', 'delivery-bar', 'delivery-fail', 'delivered', 'failed',
  ]);
  // Class strings: className attributes, and the shared class constants of table-styles.ts.
  const classTokens = (path, source) =>
    [
      ...[...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]),
      ...[...source.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ' ')),
      ...(path.endsWith('table-styles.ts') ? [...source.matchAll(/=\s*[`']([^`']*)[`'];/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ' ')) : []),
    ].flatMap((value) => value.split(/\s+/).filter(Boolean));
  for (const path of [...files, ...Object.values(FE4_PAGES)]) {
    const source = read(path);
    assert.doesNotMatch(source, /'use client'/, `${path} stays a server component`);
    assert.doesNotMatch(source, /(?<![\w&])#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${path}: no raw colours; charts use --chart-* and --jale-card, chrome uses tokens`);
    const legacy = classTokens(path, source).filter((token) => LEGACY.has(token));
    assert.deepEqual(legacy, [], `${path}: no legacy class names`);
  }
  for (const path of helpers) {
    assert.doesNotMatch(read(path), /#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(/, `${path}: no raw colours`);
  }
}
// ==== end D11 gates ====

console.log('admin UI analytics contract checks passed');
