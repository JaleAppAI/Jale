// FE-4 (S28): the D11 chart components rendered with react-dom/server, as the
// server sends them. Every chart titles both axes, ticks with units, puts a
// value on every point and bar, draws the partial last bucket hollow, keys
// two or more series, and carries a text alternative; funnels print
// "NN% · count"; "collecting since" panels draw empty, labelled axes. A
// missing xTitle or yTitle is a type error (compile probe at the end).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { adminRoot, compileAdminSources } from './lib/check-harness.mjs';
import { ADVERSARIAL_26, CONVERGING_3, WEEKS_26, WEEKS_8 } from './fixtures/fe4-series.mjs';

const CHARTS = 'src/components/analytics/charts';
const { load } = compileAdminSources({
  name: 'charts-render',
  sources: [
    `${CHARTS}/ChartFrame.tsx`,
    `${CHARTS}/LineChart.tsx`,
    `${CHARTS}/text.ts`,
    `${CHARTS}/BarChart.tsx`,
    `${CHARTS}/FunnelChart.tsx`,
    `${CHARTS}/StackedLines.tsx`,
    `${CHARTS}/CollectingSince.tsx`,
    `src/components/analytics/AnalyticsPanel.tsx`,
    `src/components/analytics/PipelinesStrip.tsx`,
    // (B2) BarChart, (B3) FunnelChart, (B4) StackedLines and CollectingSince are added here.
  ],
  fakes: { 'next/link': 'scripts/fakes/next-link.mjs' },
});
const { ChartFrame } = await load(`${CHARTS}/ChartFrame.tsx`);
const { LineChart } = await load(`${CHARTS}/LineChart.tsx`);
const { BarChart } = await load(`${CHARTS}/BarChart.tsx`);
const { FunnelChart } = await load(`${CHARTS}/FunnelChart.tsx`);
const { StackedLines } = await load(`${CHARTS}/StackedLines.tsx`);
const { CollectingSince } = await load(`${CHARTS}/CollectingSince.tsx`);
const { AnalyticsPanel, Headline } = await load('src/components/analytics/AnalyticsPanel.tsx');
const { PipelinesStrip } = await load('src/components/analytics/PipelinesStrip.tsx');
// (B2-B4) one load line per new chart goes here.
const text = await load(`${CHARTS}/text.ts`);
const fmt = await load('src/lib/analytics-format.ts');

const html = (component, props) => renderToStaticMarkup(createElement(component, props));
const unescape = (s) => s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#x27;', "'");
// Inner text of every element carrying `attr` (elements here hold plain text).
const textsOf = (markup, attr) => [...markup.matchAll(new RegExp(`<(\\w+)[^>]*\\b${attr}[^>]*>([^<]*)</\\1>`, 'g'))].map((m) => unescape(m[2]));
const count = (markup, pattern) => (markup.match(pattern) ?? []).length;
const label = (n) => fmt.weekLabel(n);

function assertD11Axes(name, markup, xTitle, yTitle) {
  assert.deepEqual(textsOf(markup, 'data-axis-title="x"'), [xTitle], `${name}: the x axis is titled`);
  assert.deepEqual(textsOf(markup, 'data-axis-title="y"'), [yTitle], `${name}: the y axis is titled`);
  assert.match(markup, /role="img"/, `${name}: the figure is an image to assistive tech`);
  assert.match(markup, /aria-label="[^"]+"/, `${name}: with a text label`);
  assert.doesNotMatch(markup, /style="[^"]*(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/, `${name}: inline colours come only from tokens`);
}

// ---- LineChart (T2) ----
const labels26 = WEEKS_26.map(label);
const twoSeries = [
  { key: 'a', label: 'Workers', color: 'chart-1', values: ADVERSARIAL_26.zigzag },
  { key: 'b', label: 'Employers', color: 'chart-2', values: ADVERSARIAL_26.gaps },
];
{
  const markup = html(LineChart, { title: 'Signups', labels: labels26, series: twoSeries, xTitle: 'Week starting', yTitle: 'Total signups', partialLast: true });
  assertD11Axes('LineChart', markup, 'Week starting', 'Total signups');
  const expected = [];
  for (let i = 0; i < 26; i += 1) for (const s of twoSeries) if (s.values[i] !== null) expected.push(fmt.formatCount(s.values[i]));
  assert.deepEqual(textsOf(markup, 'data-value-label'), expected, 'LineChart: a value on every point, in order');
  assert.equal(count(markup, /data-marker=""/g), expected.length, 'LineChart: a marker on every point');
  // The gaps series has no value in the last week: no point, so nothing hollow there.
  assert.equal(count(markup, /data-hollow="true"/g), 1, 'LineChart: the partial week is a hollow point');
  assert.match(markup, /data-hollow="true"[^>]*style="[^"]*background:var\(--jale-card\)/, 'LineChart: the hollow point fills with the card');
  const legend = markup.match(/<ul data-chart-legend[\s\S]*?<\/ul>/)?.[0] ?? '';
  assert.match(legend, /Workers/);
  assert.match(legend, /Employers/);
  assert.match(legend, /Hollow point = current week so far/, 'LineChart: the legend explains the hollow point');
  assert.match(markup, /stroke:var\(--chart-1\)/);
  assert.match(markup, /stroke:var\(--chart-2\)/);
  assert.match(markup, /aria-label="Signups, latest Oct 12 \(so far\): Workers 1,000,000; Employers no value"/, 'LineChart: the text label gives the latest values');
  assert.ok(textsOf(markup, 'data-tick="y"').length >= 2, 'LineChart: y ticks');
  assert.ok(textsOf(markup, 'data-tick="x"').includes('Oct 12'), 'LineChart: the last week is ticked');
}
{
  const markup = html(LineChart, {
    title: 'Views that apply',
    labels: WEEKS_8.map(label),
    series: [{ key: 'r', label: 'Public page', color: 'chart-3', values: [1.5, 2, 0.1, 99.9, 12.5, null, 3, 4] }],
    xTitle: 'Week starting',
    yTitle: 'Views that apply (%)',
    unit: '%',
    formatValue: fmt.formatRate,
  });
  assert.ok(textsOf(markup, 'data-tick="y"').every((t) => t.endsWith('%')), 'LineChart: every tick carries the unit');
  assert.deepEqual(textsOf(markup, 'data-value-label'), ['1.5%', '2%', '0.1%', '99.9%', '12.5%', '3%', '4%'], 'LineChart: values carry the unit');
  assert.doesNotMatch(markup, /data-chart-legend/, 'LineChart: one series and no partial week needs no legend');
  assert.doesNotMatch(markup, /data-hollow="true"/, 'LineChart: nothing hollow without partialLast');
}
{
  const markup = html(LineChart, { title: 'Empty', labels: WEEKS_8.map(label), series: [{ key: 'e', label: 'E', color: 'chart-1', values: Array(8).fill(null) }], xTitle: 'Week starting', yTitle: 'Count' });
  assertD11Axes('LineChart (all null)', markup, 'Week starting', 'Count');
  assert.deepEqual(textsOf(markup, 'data-tick="y"'), ['0', '1'], 'all null: a 0–1 count axis, still ticked');
  assert.equal(count(markup, /data-value-label/g), 0, 'all null: no values, no zeros');
}
{
  const markup = html(LineChart, { title: 'AI extraction completeness', labels: WEEKS_8.map(label), series: [{ key: 'v', label: 'Usable', color: 'chart-1', values: [94, 95, 93, 96, 97, 96, 98, 97] }], xTitle: 'Week starting', yTitle: 'Usable voice notes (%)', unit: '%', yMin: 80 });
  assert.equal(textsOf(markup, 'data-tick="y"')[0], '80%', '#10: the axis starts at 80% when every value is above it');
}
{
  const three = CONVERGING_3.map((values, s) => ({ key: `c${s}`, label: `Series ${s + 1}`, color: `chart-${s + 1}`, values }));
  const markup = html(LineChart, { title: 'Three', labels: labels26, series: three, xTitle: 'Week starting', yTitle: 'Count', partialLast: true });
  assert.equal(count(markup, /data-value-label/g), 78, 'three converging series: all 78 values labelled');
}

// ---- BarChart (T2) ----
{
  const values = ADVERSARIAL_26.spikes;
  const markup = html(BarChart, { title: 'Jobs posted', labels: labels26, series: [{ key: 'j', label: 'Jobs posted', color: 'chart-1', values }], xTitle: 'Week starting', yTitle: 'Jobs posted', partialLast: true });
  assertD11Axes('BarChart vertical', markup, 'Week starting', 'Jobs posted');
  assert.equal(count(markup, /data-bar=""/g), 26, 'BarChart: one bar per week (a zero bar has no height)');
  assert.deepEqual(textsOf(markup, 'data-value-label'), values.map((v) => fmt.formatCount(v)), 'BarChart: a value on every bar');
  assert.equal(count(markup, /data-hollow="true"/g), 1, 'BarChart: the partial week is a hollow bar');
  assert.match(markup, /Hollow bar = current week so far/);
}
{
  const markup = html(BarChart, {
    title: 'Open cases by age',
    orientation: 'horizontal',
    labels: ['Under 1 hour', '1 to 4 hours', '4 to 24 hours', '1 to 3 days', 'Over 3 days'],
    series: [
      { key: 'us', label: 'Waiting on us', color: 'chart-1', values: [2, 3, 0, 1, 1] },
      { key: 'worker', label: 'Waiting on the worker', color: 'chart-2', values: [0, 1, 4, 0, 2] },
    ],
    xTitle: 'Open cases',
    yTitle: 'Waiting time',
  });
  assertD11Axes('BarChart horizontal', markup, 'Open cases', 'Waiting time');
  assert.equal(count(markup, /data-value-label/g), 10, 'horizontal: a value on every bar, zeros included');
  assert.match(markup, /data-chart-legend/, 'horizontal: two series get a legend');
}
// ---- FunnelChart (T3) ----
{
  const stages = [
    { key: 'started', label: 'Started', count: 1000 },
    { key: 'code', label: 'Requested a code', count: 940 },
    { key: 'verified', label: 'Verified', count: 3 },
    { key: 'ready', label: 'Ready', count: 0 },
    { key: 'almost', label: 'Almost all', count: 999 },
  ];
  const markup = html(FunnelChart, { title: 'Onboarding', stages, xTitle: 'Share of workers who started (%) · count', yTitle: 'Onboarding step' });
  assertD11Axes('FunnelChart', markup, 'Share of workers who started (%) · count', 'Onboarding step');
  assert.deepEqual(textsOf(markup, 'data-value-label'), ['100% · 1,000', '94% · 940', '<1% · 3', '0% · 0', '>99% · 999'], 'FunnelChart: "NN% · count" per stage');
  const empty = html(FunnelChart, { title: 'None', stages: [{ key: 'a', label: 'A', count: 0 }, { key: 'b', label: 'B', count: 0 }], xTitle: 'x', yTitle: 'y' });
  assert.deepEqual(textsOf(empty, 'data-value-label'), ['— · 0', '— · 0'], 'FunnelChart: no base prints a dash, never NaN%');
  assert.doesNotMatch(empty, /NaN|Infinity/);
}
// ---- StackedLines (T2) ----
{
  const six = Object.values(ADVERSARIAL_26).slice(0, 6).map((values, s) => ({ key: `s${s}`, label: `Source ${s + 1}`, color: `chart-${s + 1}`, values }));
  const markup = html(StackedLines, { title: 'Where signups come from', labels: labels26, series: six, xTitle: 'Week starting', yTitle: 'Signups per week', partialLast: true });
  assertD11Axes('StackedLines', markup, 'Week starting', 'Signups per week');
  assert.equal(count(markup, /data-row-label/g), 6, 'StackedLines: one named row per series');
  assert.equal(count(markup, /data-value-label/g), six.flatMap((s) => s.values).filter((v) => v !== null).length, 'StackedLines: a value on every point');
  const legend = markup.match(/<ul data-chart-legend[\s\S]*?<\/ul>/)?.[0] ?? '';
  for (const s of six) assert.match(legend, new RegExp(s.label), `StackedLines: ${s.label} in the legend`);
}

// ---- CollectingSince (T4) ----
{
  const markup = html(CollectingSince, { title: 'Job template reuse', xTitle: 'Week since release', yTitle: 'Jobs from a template (%)', unit: '%', slots: 8 });
  assertD11Axes('CollectingSince', markup, 'Week since release', 'Jobs from a template (%)');
  assert.deepEqual(textsOf(markup, 'data-tick="y"'), ['0%'], 'CollectingSince: the zero tick with its unit');
  assert.deepEqual(textsOf(markup, 'data-tick="x"'), ['Week 1', 'Week 8'], 'CollectingSince: the x axis runs Week 1 to Week 8');
  assert.deepEqual(textsOf(markup, 'data-collecting-since'), [`No data yet · collecting since ${fmt.ANALYTICS_RELEASE_LABEL}`]);
  assert.equal(count(markup, /data-value-label|data-marker|data-bar/g), 0, 'CollectingSince: no point, no bar, no value');
  assert.match(markup, /aria-label="Empty chart: Job template reuse\. No data yet · collecting since/);
}
// (B2-B4) the bar, funnel, small-multiple and collecting-since sections go here.

// ---- ChartFrame and the text alternatives ----
{
  const table = text.seriesTable('Signups by week', ['Oct 5', 'Oct 12'], twoSeries.map((s) => ({ ...s, values: [5, null] })), { format: fmt.formatCount, partialLast: true });
  assert.deepEqual(table, { caption: 'Signups by week', columns: ['Week', 'Workers', 'Employers'], rows: [['Oct 5', '5', '5'], ['Oct 12 (so far)', '—', '—']] });
  const markup = html(ChartFrame, { title: 'Signups, cumulative', tag: '#1', howCounted: 'Counted when the account is created.', table, children: createElement('div', null, 'chart') });
  assert.match(markup, /<h2[^>]*>Signups, cumulative<\/h2>/);
  assert.deepEqual(textsOf(markup, 'data-item-tag'), ['#1'], 'ChartFrame: the list tag');
  assert.deepEqual(textsOf(markup, 'data-how-counted'), ['Counted when the account is created.']);
  assert.match(markup, /<details[^>]*><summary[^>]*>Table<\/summary>/, 'ChartFrame: a native, keyboard-reachable table twin');
  assert.match(markup, /role="region" aria-label="Signups, cumulative table" tabindex="0"/i, 'ChartFrame: the twin scrolls in its own region');
  assert.match(markup, /<caption[^>]*>Signups by week<\/caption>/);
  assert.match(markup, /<td[^>]*>Oct 12 \(so far\)<\/td>/);
  const empty = html(ChartFrame, { title: 'T', table: { caption: 'c', columns: ['Week', 'A'], rows: [] }, children: null });
  assert.match(empty, /<td colSpan="2"[^>]*>No data yet<\/td>/i, 'ChartFrame: an empty twin says so');
}
assert.equal(
  text.chartSummary('Signups', ['Oct 5', 'Oct 12'], [{ key: 'w', label: 'Workers', color: 'chart-1', values: [3, 4] }], fmt.formatCount, '', true),
  'Signups, latest Oct 12 (so far): Workers 4',
);
assert.equal(text.chartSummary('Signups', [], [], fmt.formatCount), 'Signups: no data');

// ---- Panels that are not charts (B5) ----
{
  const panel = html(AnalyticsPanel, { title: 'Stale jobs', tag: '#4', howCounted: 'What counts as an employer action.', children: createElement(Headline, { value: '6', note: 'open jobs with no employer action' }) });
  assert.match(panel, /<h2[^>]*>Stale jobs<\/h2>/);
  assert.deepEqual(textsOf(panel, 'data-item-tag'), ['#4']);
  assert.deepEqual(textsOf(panel, 'data-how-counted'), ['What counts as an employer action.']);
  assert.match(panel, /data-headline=""[^>]*>6<span[^>]*>open jobs with no employer action<\/span><\/p>/, 'Headline: the figure, then its words');
  // Amendment N: facts the one-liner cannot hold sit under "More about these numbers".
  const withNotes = html(AnalyticsPanel, {
    title: 'Stale jobs',
    howCounted: 'What counts as an employer action.',
    notes: ['A job that was paused and reopened counts its idle days from the last employer action.', 'Deleted jobs drop out of every figure.'],
    children: createElement(Headline, { value: '6' }),
  });
  assert.match(withNotes, /<details[^>]*data-panel-notes=""[^>]*>\s*<summary[^>]*>More about these numbers<\/summary>/, 'notes: a details with the summary "More about these numbers"');
  assert.doesNotMatch(withNotes, /<details[^>]*\bopen\b/, 'notes: collapsed by default');
  assert.equal(count(withNotes, /<details\b/g), 1, 'notes: one details per panel');
  assert.deepEqual(
    textsOf(withNotes, 'data-panel-note'),
    ['A job that was paused and reopened counts its idle days from the last employer action.', 'Deleted jobs drop out of every figure.'],
    'notes: each note is its own paragraph',
  );
  assert.ok(withNotes.indexOf('data-how-counted') < withNotes.indexOf('<details'), 'notes: under the one-line how it is counted');
  assert.deepEqual(textsOf(withNotes, 'data-how-counted'), ['What counts as an employer action.'], 'notes: the one-liner is unchanged');
  assert.doesNotMatch(withNotes.match(/<details[\s\S]*<\/details>/)[0], /class="[^"]*\b(?:muted|card|panel-head)\b|style="/, 'notes: design-system classes only');
  assert.match(withNotes.match(/<details[\s\S]*<\/details>/)[0], /var\(--jale-ink-2\)/, 'notes: theme tokens, so dark mode follows');
  for (const notes of [undefined, []]) {
    const none = html(AnalyticsPanel, { title: 'Stale jobs', howCounted: 'One line.', notes, children: createElement(Headline, { value: '6' }) });
    assert.doesNotMatch(none, /<details|More about these numbers|data-panel-note/, `notes: nothing renders for ${notes === undefined ? 'no notes' : 'an empty list'}`);
  }
  const strip = html(PipelinesStrip, {
    items: [
      { tag: '#9', label: 'Billing webhooks stuck or failed, last hour', value: '0', hint: '0 dead-lettered in the last 14 days' },
      { tag: '#11', label: 'Messages queued · dead-lettered', value: '3 · —', hint: "Dead-letter queues: Couldn't read right now" },
      { tag: '#19', label: 'Candidate rankings older than 24h', value: '3 jobs', hint: 'of 12 ranked' },
    ],
  });
  assert.match(strip, /<h2[^>]*>Pipelines, right now<\/h2>/);
  assert.deepEqual(textsOf(strip, 'data-item-tag'), ['#9', '#11', '#19'], 'each pipeline keeps its list tag');
  assert.deepEqual(textsOf(strip, 'data-pipeline-value'), ['0', '3 · —', '3 jobs']);
  assert.match(strip, /Couldn't read right now|Couldn&#x27;t read right now/, 'an unreadable source says so');
  assert.doesNotMatch(panel + strip, /style="[^"]*(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/, 'panels: inline colours come only from tokens');
}
// ---- Server components only ----
for (const file of readdirSync(resolve(adminRoot, CHARTS))) {
  assert.doesNotMatch(readFileSync(resolve(adminRoot, CHARTS, file), 'utf8'), /'use client'/, `${file} stays a server component`);
}

// ---- A missing xTitle or yTitle does not compile ----
const probeDir = resolve(adminRoot, '.test-artifacts', 'charts-props-probe');
mkdirSync(probeDir, { recursive: true });
const probe = resolve(probeDir, 'probe.tsx');
const PROBES = [
  ['LineChart', '<LineChart title="t" labels={[]} series={[]} yTitle="y" />', 'xTitle'],
  ['LineChart', '<LineChart title="t" labels={[]} series={[]} xTitle="x" />', 'yTitle'],
  ['BarChart', '<BarChart title="t" labels={[]} series={[]} yTitle="y" />', 'xTitle'],
  ['BarChart', '<BarChart title="t" labels={[]} series={[]} xTitle="x" />', 'yTitle'],
  ['FunnelChart', '<FunnelChart title="t" stages={[]} yTitle="y" />', 'xTitle'],
  ['FunnelChart', '<FunnelChart title="t" stages={[]} xTitle="x" />', 'yTitle'],
  ['StackedLines', '<StackedLines title="t" labels={[]} series={[]} yTitle="y" />', 'xTitle'],
  ['StackedLines', '<StackedLines title="t" labels={[]} series={[]} xTitle="x" />', 'yTitle'],
  ['CollectingSince', '<CollectingSince title="t" slots={8} yTitle="y" />', 'xTitle'],
  ['CollectingSince', '<CollectingSince title="t" slots={8} xTitle="x" />', 'yTitle'],
  // (B2-B4) two rows per new chart go here.
];
const header = [...new Set(PROBES.map(([name]) => name))]
  .map((name) => `import { ${name} } from '@/components/analytics/charts/${name}';`)
  .join('\n');
writeFileSync(probe, `${header}\n${PROBES.map(([, jsx], i) => `export const probe${i} = ${jsx};`).join('\n')}\n`);
const probeProgram = ts.createProgram([probe], {
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: ['node'],
  jsx: ts.JsxEmit.ReactJSX,
  paths: { '@/*': [`${resolve(adminRoot, 'src').split('\\').join('/')}/*`] },
});
const probeDiagnostics = ts.getPreEmitDiagnostics(probeProgram).filter((d) => d.file && resolve(d.file.fileName) === probe);
const headerLines = header.split('\n').length;
PROBES.forEach(([name, , prop], i) => {
  const line = headerLines + i;
  const onLine = probeDiagnostics.filter((d) => d.file.getLineAndCharacterOfPosition(d.start).line === line);
  assert.equal(onLine.length, 1, `${name} without ${prop}: exactly one type error`);
  assert.equal(onLine[0].code, 2741, `${name} without ${prop}: TS2741 (a required property is missing)`);
  assert.match(ts.flattenDiagnosticMessageText(onLine[0].messageText, '\n'), new RegExp(`'${prop}'`), `${name}: the error names ${prop}`);
});
assert.equal(probeDiagnostics.length, PROBES.length, 'the probe has no other type errors');

console.log('check-ui-charts-render: all assertions passed');
