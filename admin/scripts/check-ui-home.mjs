// T4: Home (prototype "Main") renders every section from the K2.1, K2.2 and
// K3.4 loaders (faked here): the state of each health item in words, the
// reads in waves within the pool cap, and each section failing on its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { adminRoot, compileAdminSources } from './lib/check-harness.mjs';
import { STUB, homeData } from './fixtures/fe1-home-data.mjs';

const homeSource = readFileSync(resolve(adminRoot, 'src/app/(console)/page.tsx'), 'utf8');
// On the old code Home still drew the case dashboard from loadAdminDashboard.
assert.doesNotMatch(homeSource, /loadAdminDashboard/, 'Home reads the inbox counts, health, metrics and activity (K2.1, K2.2, K3.4), not the old dashboard loader');

const { load } = compileAdminSources({
  name: 'fe1-home',
  sources: ['src/app/(console)/page.tsx', 'src/components/home/home-format.ts'],
  fakes: {
    'next/link': 'scripts/fixtures/fe1-fake-next-link.mjs',
    'src/lib/server/session.ts': 'scripts/fakes/session.mjs',
    'src/lib/server/admin-inbox.ts': 'scripts/fixtures/fe1-fake-admin-inbox.mjs',
    'src/lib/server/admin-analytics.ts': 'scripts/fixtures/fe1-fake-admin-analytics.mjs',
  },
});
const { default: HomePage } = await load('src/app/(console)/page.tsx');
const fmt = await load('src/components/home/home-format.ts');

const OPS = { preview: true, sub: 'check-admin', email: 'ops-admin@example.test', role: 'admin_ops', groups: ['admin_ops'] };
async function renderHome(overrides = {}) {
  globalThis.__adminCheck = { session: OPS, ...homeData(Date.now()), ...overrides };
  const markup = renderToStaticMarkup(await HomePage());
  return { markup, check: globalThis.__adminCheck };
}
const prefetch = (markup) => [...markup.matchAll(/data-prefetch="([^"]*)"/g)].map((m) => m[1]);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every section, with the prototype's numbers.
{
  const { markup, check } = await renderHome();
  assert.deepEqual(check.calls.slice(0, 3).sort(), ['getHomeMetrics', 'getInboxCounts', 'getSystemHealth'], 'wave 1: counts, metrics, health');
  assert.equal(check.calls[3], 'loadRecentActivity', 'wave 2: activity');
  assert.ok(check.maxInflight <= 3, `Home ran ${check.maxInflight} reads at once; the pool cap allows 3`);
  assert.equal(check.countsSession, OPS, 'the counts are read for the signed-in admin');

  assert.match(markup, /<h1[^>]*>Home<\/h1>/);
  assert.match(markup, />What needs you first, then how the platform is doing\.</);
  assert.match(markup, /<strong[^>]*>3 new<\/strong> since your last visit/);

  for (const href of ['/inbox?tab=support', '/inbox?tab=reports', '/inbox?tab=lockouts', '/inbox?tab=all']) {
    assert.match(markup, new RegExp(`<a\\b[^>]*href="${escape(href)}"`), `a Needs action card links ${href}`);
  }
  for (const text of ['Needs action', 'Support conversations', '2 unread', 'Problem reports', 'Verification lockouts', 'Delivery issues', 'All clear']) {
    assert.ok(markup.includes(`>${text}<`), `Needs action shows "${text}"`);
  }
  assert.match(markup, />Oldest waiting <strong[^>]*>3h 12m<\/strong></);
  assert.match(markup, />Oldest new <strong[^>]*>1d 4h<\/strong></);
  assert.match(markup, />Locked <strong[^>]*>25m<\/strong> ago</);

  assert.ok(markup.includes('>System health · last 24 hours<'));
  for (const [label, state] of [['WhatsApp delivery', 'Healthy'], ['Billing webhooks', 'Problem'], ['Email bounces', 'Watch'], ['AI extraction', 'Unknown']]) {
    assert.match(markup, new RegExp(`>${state}</span></span><span[^>]*>${label}<`), `${label} reads "${state}" in words, next to its dot`);
  }

  // Empty cells of the health grid read as card, not as the hairline colour.
  const healthList = markup.match(/<section aria-labelledby="home-health"[\s\S]*?<ul class="([^"]*)">([\s\S]*?)<\/ul>/);
  assert.ok(healthList, 'the health list renders');
  assert.doesNotMatch(healthList[1], /bg-\[var\(--jale-divider\)\]/, 'the health list does not paint the divider colour: an unfilled grid cell would show it as a block');
  assert.match(healthList[1], /bg-\[var\(--jale-card\)\]/, 'the health list is card-coloured behind its items');
  const healthItems = healthList[2].match(/<li class="[^"]*"/g) ?? [];
  assert.equal(healthItems.length, 5, 'five health items');
  for (const item of healthItems) assert.ok(item.includes('shadow-[0_0_0_1px_var(--jale-divider)]'), 'each health item draws its own 1px divider hairline');

  for (const [value, label, hint] of [
    ['1,240', 'Signups, all time', '+144 this week so far'], ['18', 'Paying companies', '+2 this week'],
    ['26', 'Hires, last 30 days', '19 jobs with a hire'], ['41', 'Open jobs', '6 stale'],
  ]) {
    assert.match(markup, new RegExp(`>${escape(value)}</p><p[^>]*>${escape(label)}</p><div[^>]*><span[^>]*>${escape(hint)}</span>`), `the ${label} tile`);
  }
  assert.match(markup, /<a\b[^>]*href="\/analytics"[^>]*>Open analytics <span aria-hidden="true">→<\/span><\/a>/);

  assert.ok(markup.includes('>Signups, cumulative<'));
  assert.ok(markup.includes('>Workers and companies<'), 'the chart counts workers and companies');
  assert.ok(!markup.includes('Paying employers'), 'Home says companies');
  assert.match(markup, /role="img" aria-label="Signups, cumulative, latest Oct 12 \(so far\): Signups \(cumulative\) 1,240"/, 'the chart has a text alternative with the latest value');
  assert.match(markup, /data-axis-title="x"[^>]*>Week<\/div>/, 'the x axis has a title (D11)');
  assert.match(markup, /data-axis-title="y"[^>]*>Signups<\/div>/, 'the y axis has a title (D11)');
  for (const value of ['340', '412', '486', '590', '678', '801', '930', '1,240']) {
    assert.match(markup, new RegExp(`data-value-label=""[^>]*>${escape(value)}</span>`), `point ${value} is labelled (D11)`);
  }
  assert.equal((markup.match(/data-marker="" data-hollow="true"/g) ?? []).length, 1, 'only the current partial week is hollow');
  assert.equal((markup.match(/data-marker="" data-hollow="false"/g) ?? []).length, 7, 'every other week is a filled point');
  assert.match(markup, /data-swatch="hollow"[^>]*><\/span>Hollow point = current week so far</, 'the hollow point is explained');
  assert.match(markup, /<details[\s\S]*?<summary[^>]*>Table<\/summary>[\s\S]*?Oct 12 \(so far\)/, 'a table twin, with the partial week marked');
  assert.match(markup, /role="region" aria-label="Signups, cumulative chart" tabindex="0"/, 'on a phone the chart scrolls inside its own region');

  assert.ok(markup.includes('>Recent activity<'));
  for (const ago of ['4m ago', '25m ago', '1h ago', '2h ago', '3h ago']) {
    assert.ok(markup.includes(`>${ago}</time>`), `activity shows "${ago}"`);
  }
  assert.match(markup, /<a\b[^>]*href="\/inbox\/support\/00000000-0000-4000-8000-000000000124"[^>]*>A worker sent a photo in support case S-124<\/a>/);
  assert.ok(markup.includes('>Ops admin resolved support case S-118<'), 'an item without href is plain text');
  assert.doesNotMatch(markup, /href="https:\/\/example\.test/, 'an href that is not an in-app path is plain text');
  assert.ok(markup.includes('A paused job reopened after its employer&#x27;s payment went through'));

  assert.equal(prefetch(markup).length, 8, 'four cards, Open analytics, three in-app activity links');
  assert.deepEqual([...new Set(prefetch(markup))], ['false'], 'Home links never prefetch');
}

// What the step-0 stubs return today: every section says so instead of breaking.
{
  const { markup } = await renderHome(STUB);
  assert.doesNotMatch(markup, /since your last visit/);
  assert.ok(markup.includes('>Counts unavailable<'), 'no counts: Needs action says so');
  assert.ok(markup.includes('>No health checks to show<'));
  assert.ok(markup.includes('>No data yet<'), 'no weeks: the chart says so');
  assert.ok(markup.includes('>No recent activity<'));
  assert.match(markup, />0<\/p><p[^>]*>Signups, all time<\/p>/);
}
for (const newSinceLastVisit of [0, null]) {
  const { markup } = await renderHome({ counts: { ...homeData(Date.now()).counts, newSinceLastVisit } });
  assert.doesNotMatch(markup, /since your last visit/, `newSinceLastVisit ${newSinceLastVisit}: hidden`);
}

// One failing read blanks only its own section.
{
  const { markup } = await renderHome({ metricsError: new Error('metrics read failed') });
  assert.ok(markup.includes('>Metrics unavailable<'));
  assert.ok(markup.includes('>Support conversations<'), 'Needs action still renders');
  assert.ok(markup.includes('>System health · last 24 hours<'), 'health still renders');
  assert.ok(markup.includes('>4m ago</time>'), 'activity still renders');
}
{
  const { markup } = await renderHome({ activityError: new Error('activity read failed'), healthError: new Error('health read failed'), countsError: new Error('count read failed') });
  assert.ok(markup.includes('>Activity unavailable<'));
  assert.ok(markup.includes('>Health unavailable<'));
  assert.ok(markup.includes('>Counts unavailable<'));
  assert.match(markup, />1,240<\/p>/, 'metrics still render');
}

// The pure helpers.
{
  const NOW = Date.parse('2026-10-14T12:00:00.000Z');
  const zero = {
    waitingOnUs: 0, support: 0, reports: 0, lockouts: 0, deliveryIssues: 0, unreadSupport: 0,
    oldestWaiting: { support: null, reports: null, lockouts: null }, newSinceLastVisit: null,
  };
  assert.deepEqual(fmt.needsActionCards(zero, NOW).map((card) => [card.key, card.clear]), [['support', true], ['reports', true], ['lockouts', true], ['delivery', true]]);
  assert.equal(fmt.needsActionCards({ ...zero, support: 2 }, NOW)[0].detail, null, 'a count without an oldest time shows no wait');
  assert.equal(
    fmt.needsActionCards({ ...zero, support: 1, oldestWaiting: { ...zero.oldestWaiting, support: '2026-10-14T12:05:00.000Z' } }, NOW)[0].detail.value,
    '0m',
    'a server clock ahead of ours never prints a negative wait',
  );
  assert.equal(fmt.needsActionCards({ ...zero, deliveryIssues: 3 }, NOW)[3].href, '/inbox?tab=all', 'delivery issues open the All tab (CCR-7)');
  assert.equal(fmt.keyMetricTiles({ ...STUB.metrics, hiresLast30d: 1, jobsWithHireLast30d: 1 })[2].hint, '1 job with a hire');
  assert.deepEqual([fmt.newSinceText(null), fmt.newSinceText(0), fmt.newSinceText(1200)], [null, null, '1,200 new']);
  for (const href of ['/inbox', '/inbox/support/x?y=1']) assert.equal(fmt.isInAppPath(href), true, href);
  for (const href of ['https://example.test/x', '//example.test/x', '/\\example.test', 'mailto:ops@example.test', '', null]) assert.equal(fmt.isInAppPath(href), false, String(href));
}

delete globalThis.__adminCheck;
console.log('T4 Home: ok');
