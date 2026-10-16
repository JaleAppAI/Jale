// The Security page (K1.6): the tabs and the filters each one presets, the
// Range presets (sent as From), and the Admin filter
// (src/components/security/security-query.ts). The rendered view is checked
// further down. Every href is built from ACCESS_HISTORY_PATH; the literal
// '/security' is pinned once, at the end of the lane.
import assert from 'node:assert/strict';
import { compileAdminSources } from './lib/check-harness.mjs';
import { ADMIN, ADMIN_OPTIONS, ADMIN_TWO, NOW_ISO, OTHER_ACTOR, WORKER } from './fixtures/fe3-security.mjs';

// A fixed zone with daylight saving, so local times below are exact.
process.env.TZ = 'America/Chicago';

const { load } = compileAdminSources({
  name: 'fe3-security-view',
  sources: ['src/components/security/security-query.ts', 'src/lib/access-history.ts', 'src/lib/local-time.ts'],
});
const query = await load('src/components/security/security-query.ts');
const history = await load('src/lib/access-history.ts');
const P = history.ACCESS_HISTORY_PATH;

// --- Tabs: K1.6's presets ------------------------------------------------------------
assert.deepEqual(query.securityTabItems({}), [
  { label: 'Access history', href: P, active: true },
  { label: 'Admin actions', href: `${P}?outcome=done`, active: false },
  { label: 'Sign-ins', href: `${P}?category=admin_access`, active: false },
]);
assert.equal(query.activeSecurityTab({}), 'access');
assert.equal(query.activeSecurityTab({ outcome: 'done' }), 'actions');
assert.equal(query.activeSecurityTab({ category: 'admin_access' }), 'sign-ins');
assert.equal(query.activeSecurityTab({ category: 'admin_access', outcome: 'done' }), 'access', 'both presets at once is no tab of its own');
assert.equal(query.activeSecurityTab({ outcome: 'denied' }), 'access');
// A tab keeps the other filters, swaps its preset in, and starts at the newest page.
const from = '2026-10-07T17:00:00.000Z';
const kept = query.securityTabItems({ actorId: ADMIN, from, category: 'admin_access' });
assert.deepEqual(kept.map((tab) => tab.href), [
  `${P}?actor=${ADMIN}&from=2026-10-07T17%3A00%3A00.000Z`,
  `${P}?actor=${ADMIN}&from=2026-10-07T17%3A00%3A00.000Z&outcome=done`,
  `${P}?actor=${ADMIN}&from=2026-10-07T17%3A00%3A00.000Z&category=admin_access`,
]);
assert.deepEqual(kept.map((tab) => tab.active), [false, false, true]);
assert.equal(query.securityClearHref({ actorId: ADMIN, category: 'admin_access' }), `${P}?category=admin_access`, 'clearing keeps the tab');
assert.equal(query.securityClearHref({ subjectUserId: WORKER }), P);

// --- Range: last 7 or 30 days from the server render, to the whole minute ------
assert.deepEqual(query.rangeOptions('2026-10-14T12:00:30.500Z'), [
  { id: '7d', label: 'Last 7 days', from: '2026-10-07T12:00:00.000Z' },
  { id: '30d', label: 'Last 30 days', from: '2026-09-14T12:00:00.000Z' },
]);
const ranges = query.rangeOptions(NOW_ISO);
const submitted = (fields) => history.accessHistorySearchHref(query.securitySearchFields(fields, ranges));
assert.equal(submitted({ range: '7d', fromLocal: '' }), `${P}?from=2026-10-07T12%3A00%3A00.000Z`, 'the range produces from');
assert.equal(submitted({ range: '30d', fromLocal: '' }), `${P}?from=2026-09-14T12%3A00%3A00.000Z`);
assert.equal(submitted({ range: '7d', fromLocal: '2026-10-01T08:00' }), `${P}?from=2026-10-01T13%3A00%3A00.000Z`, 'a typed From wins over the range');
assert.equal(submitted({ range: '', fromLocal: '' }), P, 'any time sends no from');
assert.equal(submitted({ range: '90d' }), P, 'an unknown range is ignored');
assert.equal(submitted({ range: 'custom', fromLocal: '2026-10-01T08:00', actor: ADMIN }), `${P}?actor=${ADMIN}&from=2026-10-01T13%3A00%3A00.000Z`);
// Review Focus 5: what the Range select shows for a search's From.
assert.equal(query.rangeSelection(undefined, ranges), '');
assert.equal(query.rangeSelection(ranges[0].from, ranges), '7d');
assert.equal(query.rangeSelection(ranges[1].from, ranges), '30d');
assert.equal(query.rangeSelection('2026-10-07T12:59:00.000Z', ranges), '7d', 'a page paged within the hour still shows its range');
assert.equal(query.rangeSelection('2026-10-07T13:01:00.000Z', ranges), 'custom', 'later than that it is a custom range');
assert.equal(query.rangeSelection('not a time', ranges), 'custom');
assert.equal(query.RANGE_MATCH_TOLERANCE_MS, 60 * 60 * 1000);

// --- The Admin filter --------------------------------------------------------------
assert.deepEqual(query.actorOptions(ADMIN_OPTIONS, undefined), {
  options: [
    { value: '', label: 'Everyone' },
    { value: ADMIN, label: 'ops-admin@example.test' },
    { value: ADMIN_TWO, label: 'readonly-admin@example.test' },
  ],
  selected: '',
});
// Review Focus 4: an uppercase id in a link still selects the admin.
assert.equal(query.actorOptions(ADMIN_OPTIONS, ADMIN.toUpperCase()).selected, ADMIN);
// An actor who is not on the list (or a refused value) is kept, so the search shows and repeats it.
const unknown = query.actorOptions(ADMIN_OPTIONS, OTHER_ACTOR);
assert.deepEqual(unknown.options.at(-1), { value: OTHER_ACTOR, label: OTHER_ACTOR });
assert.equal(unknown.selected, OTHER_ACTOR);
assert.deepEqual(query.adminFilterOptions({ status: 'forbidden' }), []);
assert.deepEqual(
  query.adminFilterOptions({
    status: 'ok',
    viewerId: ADMIN,
    admins: [
      { id: ADMIN_TWO, email: 'readonly-admin@example.test', role: 'admin_readonly', status: 'active', lastSignInAt: null, trustedBrowsers: 0, createdAt: NOW_ISO, isSelf: false, canResendInvite: false },
      { id: ADMIN, email: 'ops-admin@example.test', role: 'admin_ops', status: 'active', lastSignInAt: null, trustedBrowsers: 0, createdAt: NOW_ISO, isSelf: true, canResendInvite: false },
    ],
  }),
  ADMIN_OPTIONS,
  'by email',
);

// --- The view: tabs, Admin and Range filters (rendered) ---------------------------
{
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { SIGN_IN_ENTRY } = await import('./fixtures/fe3-security.mjs');
  const { load: loadView } = compileAdminSources({
    name: 'fe3-security-render',
    sources: ['src/components/security/AccessHistoryView.tsx'],
    fakes: {
      'next/link': 'scripts/fakes/next-link.mjs',
      'next/navigation': 'scripts/fakes/next-navigation.mjs',
    },
  });
  const { AccessHistoryView } = await loadView('src/components/security/AccessHistoryView.tsx');
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const amp = (href) => esc(href.replaceAll('&', '&amp;'));
  const render = (params, entries = []) => {
    const parsed = history.parseAccessHistoryQuery(params);
    const result = parsed.problems.length > 0 ? { status: 'invalid', query: parsed } : { status: 'ok', query: parsed, entries };
    return renderToStaticMarkup(createElement(AccessHistoryView, { result, admins: ADMIN_OPTIONS, nowIso: NOW_ISO }));
  };
  const tabLink = (href, current) => new RegExp(
    `<a(?=[^>]*href="${amp(href)}")${current ? '(?=[^>]*aria-current="page")' : '(?![^>]*aria-current)'}[^>]*>`,
  );
  const selected = (html, name) => html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`))?.[1]
    .match(/<option value="([^"]*)" selected="">/)?.[1] ?? '';

  // The default tab.
  {
    const html = render({});
    assert.match(html, /<nav[^>]*aria-label="Security sections"/);
    assert.match(html, tabLink(P, true));
    assert.match(html, tabLink(`${P}?outcome=done`, false));
    assert.match(html, tabLink(`${P}?category=admin_access`, false));
    assert.match(html, /<h1[^>]*>Security<\/h1>/);
    assert.match(html, /Who looked at what, who changed what, and every sign-in\. Superadmins only\./);
    for (const header of ['When', 'What', 'Who', 'Result']) {
      assert.doesNotMatch(html, new RegExp(`<th[^>]*>${header}</th>`), 'no entries: no table');
    }
  }
  // Sign-ins: the preset tab is current and a session entry reads as one.
  {
    const html = render({ category: 'admin_access' }, [SIGN_IN_ENTRY]);
    assert.match(html, tabLink(`${P}?category=admin_access`, true));
    assert.match(html, tabLink(P, false));
    for (const header of ['When', 'What', 'Who', 'Result']) {
      assert.match(html, new RegExp(`<th[^>]*scope="col"[^>]*>${header}</th>`));
    }
    assert.match(html, /<strong>Session<\/strong> <code[^>]*>admin\.session<\/code>/);
    assert.match(html, /<li data-tone="success">(?:(?!<\/li>)[\s\S])*?>signed in</);
    assert.match(html, /<dt[^>]*>Fields<\/dt><dd>trusted_device<\/dd>/);
  }
  // Admin actions.
  assert.match(render({ outcome: 'done' }), tabLink(`${P}?outcome=done`, true));
  // The Admin filter: Everyone and the admins by email; a deep link selects its admin.
  {
    const html = render({ actor: ADMIN.toUpperCase() });
    assert.match(html, /<option value="">Everyone<\/option>/);
    assert.match(html, new RegExp(`<option value="${ADMIN_TWO}">readonly-admin@example\\.test</option>`));
    assert.equal(selected(html, 'actor'), ADMIN);
    assert.equal(selected(render({ actor: OTHER_ACTOR }), 'actor'), OTHER_ACTOR, 'an actor not on the list is kept');
    const refused = render({ actor: 'not-an-id' });
    assert.match(refused, /<select(?=[^>]*id="history-actor")(?=[^>]*aria-invalid="true")[^>]*>/);
  }
  // Range: Any time by default; a preset From selects its preset and keeps
  // "More filters" closed with From empty; any other From is a custom range.
  {
    const ranges = query.rangeOptions(NOW_ISO);
    const none = render({});
    assert.equal(selected(none, 'range'), '');
    assert.match(none, /<option value="7d">Last 7 days<\/option>/);
    assert.match(none, /<option value="30d">Last 30 days<\/option>/);
    assert.match(none, /<option value="" selected="">Any time<\/option>/);
    assert.doesNotMatch(none, /value="custom"/);
    assert.doesNotMatch(none, /<details[^>]*open/);
    const preset = render({ from: ranges[0].from });
    assert.equal(selected(preset, 'range'), '7d');
    assert.doesNotMatch(preset, /<details[^>]*open/);
    const custom = render({ from: '2026-10-01T00:00:00Z' });
    assert.equal(selected(custom, 'range'), 'custom');
    assert.match(custom, /<option value="custom" selected="">Custom range<\/option>/);
    assert.match(custom, /<details[^>]*open=""/);
    assert.match(custom, /<summary[^>]*>More filters<\/summary>/);
  }
  // "Clear filters" keeps the tab.
  assert.match(render({ category: 'admin_access', actor: ADMIN }), new RegExp(`<a[^>]*href="${amp(`${P}?category=admin_access`)}"[^>]*>Clear filters</a>`));
}

// --- The path (K1.6): every link above goes to /security ----------------------------
assert.equal(P, '/security');
assert.deepEqual(query.securityTabItems({}).map((tab) => tab.href), ['/security', '/security?outcome=done', '/security?category=admin_access']);
assert.equal(history.accessHistoryHref({ subjectUserId: WORKER }), `/security?subject=${WORKER}`);

console.log('admin Security view checks passed');
