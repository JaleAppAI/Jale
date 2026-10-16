// Renders the Security page's access history (components/security/
// AccessHistoryView.tsx) with react-dom/server, as the server sends it before
// hydration, and checks the viewer-zone time helpers the browser uses. The
// page itself is a thin async wrapper around loadAccessHistory (checked in
// check-audit-loaders.mjs) and this view. The Security-only behaviour (tabs,
// Range, Admin filter) is in check-ui-security-view.mjs.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileAdminSources } from './lib/check-harness.mjs';
import {
  ADMIN, ADMIN_OPTIONS, CASE, CHANGE_ENTRY, DENIED_ENTRY, LEGACY_ENTRY, NOW_ISO, REVEAL_ENTRY, WORKER,
} from './fixtures/fe3-security.mjs';

// A fixed zone with daylight saving, so the conversions below are exact.
process.env.TZ = 'America/Chicago';

const { load } = compileAdminSources({
  name: 'access-history-view',
  sources: [
    'src/components/security/AccessHistoryView.tsx',
    // Listed so it compiles even before the view imports it (the red run).
    'src/components/security/security-query.ts',
    'src/lib/local-time.ts',
    'src/lib/access-history.ts',
  ],
  fakes: {
    'next/link': 'scripts/fakes/next-link.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
  },
});

const { AccessHistoryView } = await load('src/components/security/AccessHistoryView.tsx');
const { AccessHistoryFilters } = await load('src/components/security/AccessHistoryFilters.tsx');
const securityQuery = await load('src/components/security/security-query.ts');
const time = await load('src/lib/local-time.ts');
const history = await load('src/lib/access-history.ts');
const P = history.ACCESS_HISTORY_PATH;

const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const label = (id, text) => new RegExp(`<label[^>]*for="${id}"[^>]*>${esc(text)}</label>`);
const link = (href, text) => new RegExp(`<a[^>]*href="${esc(href.replaceAll('&', '&amp;'))}"[^>]*>${esc(text)}</a>`);
// A result badge: its tone sits on the list item, so the check reads tone, not classes.
const badge = (tone, text) => new RegExp(`<li data-tone="${tone}">(?:(?!</li>)[\\s\\S])*?>${esc(text)}<`, 'g');
const field = (tag, id, extra = '') => new RegExp(`<${tag}(?=[^>]*id="${id}")${extra}[^>]*>`);
const render = (result) => renderToStaticMarkup(
  createElement(AccessHistoryView, { result, admins: ADMIN_OPTIONS, nowIso: NOW_ISO }),
);

// --- Viewer-zone times -------------------------------------------------------
// The server and the browser's first render show the same UTC text; after
// hydration the browser switches to its own zone.
assert.equal(time.utcText('2026-10-01T12:00:05.123Z'), '2026-10-01 12:00:05 UTC');
assert.equal(time.isoToLocalInput('2026-10-01T17:30:00.000Z'), '2026-10-01T12:30', 'summer: UTC-5');
assert.equal(time.isoToLocalInput('2026-12-01T14:00:00Z'), '2026-12-01T08:00', 'winter: UTC-6');
assert.equal(time.isoToLocalInput(undefined), '');
assert.equal(time.isoToLocalInput('not a time'), '');
assert.equal(time.localInputToIso('2026-10-01T12:30'), '2026-10-01T17:30:00.000Z');
assert.equal(time.localInputToIso('2026-12-01T08:00'), '2026-12-01T14:00:00.000Z');
assert.equal(time.localInputToIso('2026-10-01T12:30:15'), '2026-10-01T17:30:15.000Z');
assert.equal(time.localInputToIso(''), undefined);
assert.equal(time.localInputToIso('2026-10-01'), undefined, 'a date alone is not a time');
assert.equal(time.localInputToIso('2026-10-01T12:30Z'), undefined, 'the form sends zoneless local times only');

// The search form's link: local times become instants; empty fields drop out.
assert.equal(
  history.accessHistorySearchHref({
    subject: '  00000000-0000-4000-8000-0000000000a1 ',
    actor: '',
    record: '',
    fromLocal: '2026-10-01T12:30',
    toLocal: '',
    category: 'contact_details',
    outcome: '',
  }),
  `${P}?subject=00000000-0000-4000-8000-0000000000a1&from=2026-10-01T17%3A30%3A00.000Z&category=contact_details`,
);
assert.equal(history.accessHistorySearchHref({}), P);

// --- The 403 page: a plain refusal, no search and no entries. ------------------
{
  const html = render({ status: 'forbidden' });
  assert.match(html, />403</);
  assert.match(html, /<h1[^>]*>Security is for superadmins<\/h1>/);
  assert.match(html, /Only superadmins can open Security\./);
  assert.match(html, link('/', 'Back to Home'));
  assert.doesNotMatch(html, /<form|<time|<table|<main/);
}

// --- The local preview cannot search: it has no admin id to search as. ----------
{
  const html = render({ status: 'preview' });
  assert.match(html, /<h1[^>]*>Security<\/h1>/);
  assert.match(html, /The local preview has no signed-in admin, so it cannot search the access history\./);
  assert.doesNotMatch(html, /<form|<table|<main/);
}

const emptyQuery = { filter: {}, problems: [], values: {} };

// --- A search: every entry, its time as UTC text until the browser shows its
// own zone, legacy records labelled, and nothing that can change an entry. ----
{
  const query = { filter: { subjectUserId: WORKER }, problems: [], values: { subject: WORKER } };
  const html = render({
    status: 'ok',
    query,
    entries: [REVEAL_ENTRY, DENIED_ENTRY, CHANGE_ENTRY, LEGACY_ENTRY],
    nextBefore: '2026-09-01T09:00:00.000000Z',
  });

  // The search form, with the filter it ran with.
  assert.match(html, /<form[^>]*role="search"/);
  assert.equal(count(html, /<form/g), 1);
  for (const [id, text] of [
    ['history-actor', 'Admin'],
    ['history-range', 'Range'],
    ['history-subject', 'Subject id'],
    ['history-record', 'Record id'],
    ['history-from', 'From'],
    ['history-to', 'To'],
    ['history-category', 'Category'],
    ['history-outcome', 'Outcome'],
  ]) {
    assert.match(html, label(id, text), `${text} has a label`);
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, field('input', 'history-subject', `(?=[^>]*value="${WORKER}")`));
  assert.match(html, /<option value="" selected="">Any category<\/option>/, 'no category chosen: "Any category" is selected');
  assert.match(html, /<option value="audit_history">audit history<\/option>/);
  assert.match(html, /<option value="sign_in_rejected">sign in rejected<\/option>/);
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /<details[^>]*open=""/, 'a subject search opens "More filters"');

  // The entries, newest first, each with its time.
  assert.match(html, /<h2[^>]*>Entries<\/h2>/);
  assert.match(html, /4 shown/);
  assert.equal(count(html, /<tr[^>]*data-entry="/g), 4, 'every entry is rendered');
  assert.match(html, /<time dateTime="2026-10-01T12:00:00.123Z">2026-10-01 12:00:00 UTC<\/time>/i);
  assert.match(html, /<time dateTime="2026-09-01T09:00:00.000Z">2026-09-01 09:00:00 UTC<\/time>/i);

  // The reveal: what, who, about whom, why.
  assert.match(html, /<strong>Viewed<\/strong> <code[^>]*>admin\.case_detail\.reveal<\/code>/);
  assert.equal(count(html, badge('danger', 'Contact reveal')), 2, 'the reveal, and the legacy record that revealed');
  assert.equal(count(html, badge('success', 'allowed')), 1);
  assert.match(html, /Reason:<\/span> Synthetic callback reason\./);
  assert.match(html, /ops-admin@example\.test/);
  assert.match(html, new RegExp(`href="${esc(P)}\\?subject=${WORKER}"`), 'a subject links to its own history');
  assert.match(html, new RegExp(`href="${esc(P)}\\?record=${CASE}"`), 'a record links to its own history');
  assert.match(html, new RegExp(`href="${esc(P)}\\?actor=${ADMIN}"`), 'an actor links to its own history');

  // A refusal shows as an attempt.
  assert.match(html, /<strong>Attempt<\/strong> <code[^>]*>admin\.access_history<\/code>/);
  assert.equal(count(html, badge('danger', 'denied')), 1);

  // A data change names its table and the changed fields.
  assert.equal(count(html, badge('neutral', 'Data change')), 1);
  assert.match(html, /<strong>Changed in<\/strong> <code[^>]*>public\.admin_cases<\/code>/, '111 writes operations in lower case');
  assert.match(html, /status, resolved_at/);

  // A legacy record is labelled as such.
  assert.equal(count(html, badge('warning', 'Legacy record')), 1);
  assert.match(html, /From the earlier action log\./);
  assert.match(html, /<strong>admin_ops requested reveal_pii for admin_case\.<\/strong>/);

  // The subject filter leaves out the earlier action log, and says so.
  assert.match(html, /The earlier action log names records, not people, so a subject search leaves it out\. Search by record id to include it\./);

  // Paging: the older page continues from the last entry's cursor.
  assert.match(html, link(`${P}?subject=${WORKER}&before=2026-09-01T09%3A00%3A00.000000Z`, 'Older entries'));
  assert.doesNotMatch(html, /Newest entries/, 'the first page has no way back');

  // Ids and codes are not machine-translated; nothing is marked invalid.
  assert.match(html, /<code[^>]*translate="no"[^>]*>admin\.case_detail\.reveal<\/code>/);
  assert.match(html, new RegExp(`<code[^>]*translate="no"[^>]*>${WORKER}</code>`));
  assert.doesNotMatch(html, /aria-invalid/);

  // Nothing here can change an entry: one button, the search.
  assert.equal(count(html, /<button/g), 1);
  assert.match(html, /<button(?=[^>]*type="submit")[^>]*>[\s\S]*?Search[\s\S]*?<\/button>/);
  assert.doesNotMatch(html, /method="post"|<textarea|contenteditable|<main/i);
}

// --- An older page links back to the newest entries; the category and outcome
// filters say what they leave out. ---------------------------------------------
{
  const html = render({
    status: 'ok',
    query: {
      filter: { category: 'contact_details', outcome: 'denied' },
      before: '2026-10-01T12:00:00.123456Z',
      problems: [],
      values: { category: 'contact_details', outcome: 'denied' },
    },
    entries: [],
  });
  assert.match(html, /No entries match this search\./);
  assert.match(html, link(`${P}?category=contact_details&outcome=denied`, 'Newest entries'));
  assert.doesNotMatch(html, /Older entries/);
  assert.match(html, /Only access records carry a category and an outcome, so data changes and the earlier action log are left out\./);
  assert.doesNotMatch(html, /a subject search leaves it out/);
  assert.match(html, /<option value="contact_details" selected="">contact details<\/option>/);
}

// --- An invalid search names the filters to fix, and shows no entries. ---------
{
  const query = history.parseAccessHistoryQuery({ subject: 'not-an-id', from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' });
  const html = render({ status: 'invalid', query });
  assert.match(html, /role="alert"/);
  assert.match(html, /Subject id must be a full id, 36 characters with dashes\./);
  assert.match(html, /The start of the time range must be before its end\./);
  assert.match(html, /value="not-an-id"/, 'the form keeps what was typed');
  assert.doesNotMatch(html, /<table|Entries<\/h2>/);
  // Each refused field is marked and points at the list of problems.
  assert.match(html, /<div id="history-problems">[\s\S]*?role="alert"/);
  for (const id of ['history-subject', 'history-from', 'history-to']) {
    assert.match(
      html,
      new RegExp(`<(?:input|select)(?=[^>]*id="${id}")(?=[^>]*aria-invalid="true")(?=[^>]*aria-describedby="history-problems")[^>]*>`),
      `${id} is marked invalid`,
    );
  }
  for (const id of ['history-actor', 'history-record', 'history-category', 'history-outcome']) {
    assert.doesNotMatch(html, new RegExp(`<(?:input|select)(?=[^>]*id="${id}")(?=[^>]*aria-invalid)[^>]*>`), `${id} is not marked`);
  }
}

// --- Every event carries part 1 of 1 unless it was split: only a split shows
// its part. The count is the recorded result count, whatever the surface. -------
{
  const single = render({ status: 'ok', query: emptyQuery, entries: [{ ...REVEAL_ENTRY, part: 1, parts: 1 }] });
  assert.doesNotMatch(single, /<dt[^>]*>Part<\/dt>/, 'part 1 of 1 is not shown');
  assert.match(single, /<dt[^>]*>Result count<\/dt><dd>1<\/dd>/);
  const split = render({ status: 'ok', query: emptyQuery, entries: [{ ...REVEAL_ENTRY, part: 2, parts: 3, resultCount: 0 }] });
  assert.match(split, /<dt[^>]*>Part<\/dt><dd>2 of 3<\/dd>/);
  assert.match(split, /<dt[^>]*>Result count<\/dt><dd>0<\/dd>/);
}

// --- The search form follows every search -------------------------------------
// Moving from one search to another keeps the page mounted (only its search
// parameters change), so React reuses the form unless its key changes. A
// reused form keeps what its fields showed, and a select ignores a new
// default value, so the form would show the previous search's filters and
// submit them again. Each search therefore mounts its own form, keyed by its
// values; paging changes only the cursor and keeps the form.
{
  const filtersElement = (result) => {
    const root = AccessHistoryView({ result, admins: ADMIN_OPTIONS, nowIso: NOW_ISO });
    const panel = [root.props.children].flat().find((child) => child?.type?.name === 'SearchPanel');
    assert.ok(panel, 'the view has a search panel');
    const box = panel.type(panel.props);
    const form = [box.props.children].flat().find((child) => child?.type === AccessHistoryFilters);
    assert.ok(form, 'the search panel holds the search form');
    return form;
  };
  const search = (values, before) => ({
    status: 'ok',
    query: history.parseAccessHistoryQuery({ ...values, ...(before ? { before } : {}) }),
    entries: [],
  });
  const keyOf = (values, before) => filtersElement(search(values, before)).key;

  const byCategory = { category: 'contact_details' };
  for (const [what, from, to] of [
    ['an id link from a category search', byCategory, { subject: WORKER }],
    ['a category change alone', byCategory, { category: 'cases' }],
    ['an outcome change alone', { outcome: 'denied' }, { outcome: 'failed' }],
    ['clearing an outcome filter', { outcome: 'denied' }, {}],
    ['clearing every filter', { subject: WORKER, record: CASE, category: 'cases' }, {}],
    ['a time change alone', { from: '2026-10-01T00:00:00Z' }, { from: '2026-10-02T00:00:00Z' }],
  ]) {
    const before = keyOf(from);
    const after = keyOf(to);
    assert.equal(typeof before, 'string', `${what}: the form has a key`);
    assert.notEqual(before, after, `${what}: the next search mounts a new form`);
  }
  assert.equal(
    keyOf({ subject: WORKER }, '2026-10-01T12:00:00.123456Z'),
    keyOf({ subject: WORKER }),
    'paging keeps the form: only the cursor changed',
  );
  const invalid = history.parseAccessHistoryQuery({ subject: 'not-an-id' });
  assert.equal(typeof filtersElement({ status: 'invalid', query: invalid }).key, 'string', 'an invalid search keys its form too');
  assert.notEqual(filtersElement({ status: 'invalid', query: invalid }).key, keyOf({}), 'fixing the search mounts a new form');

  // A newly mounted form shows the search it was mounted for, and submitting
  // it unchanged repeats exactly that search.
  const displayed = (html) => {
    const input = (name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0].match(/value="([^"]*)"/)?.[1] ?? '';
    const select = (name) => html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`))?.[1]
      .match(/<option value="([^"]*)" selected="">/)?.[1] ?? '';
    return {
      subject: input('subject'), actor: select('actor'), record: input('record'), range: select('range'),
      fromLocal: input('fromLocal'), toLocal: input('toLocal'),
      category: select('category'), outcome: select('outcome'),
    };
  };
  const ranges = securityQuery.rangeOptions(NOW_ISO);
  for (const values of [
    { subject: WORKER, outcome: 'denied' },
    { record: CASE, category: 'cases' },
    { actor: ADMIN },
    { from: ranges[0].from },
    {},
  ]) {
    const result = search(values);
    const shown = displayed(render(result));
    assert.equal(
      history.accessHistorySearchHref(securityQuery.securitySearchFields(shown, ranges)),
      history.accessHistoryHref(result.query.filter),
      `the form shows and submits ${JSON.stringify(values)}`,
    );
  }
}

// Every problem has a message.
for (const problem of ['subject', 'actor', 'record', 'from', 'to', 'category', 'outcome', 'before', 'range']) {
  assert.equal(typeof history.ACCESS_HISTORY_PROBLEMS[problem], 'string', `${problem} has a message`);
}
assert.deepEqual(render({ status: 'ok', query: emptyQuery, entries: [] }).match(/<h1[^>]*>[^<]*<\/h1>/g)?.length, 1);

console.log('admin access history view checks passed');
