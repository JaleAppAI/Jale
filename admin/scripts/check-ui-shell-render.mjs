// FE-1 rendered checks: the design-system primitives (A), the client helpers
// (B), the console shell (C, T2), what reaches the browser from the server
// (D, T3), the theme script (E, T6) and the fallback states (F). Components
// render with react-dom/server through the shared harness, as the server
// sends them before hydration.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adminRoot, captureConsole, compileAdminSources } from './lib/check-harness.mjs';

const read = (path) => readFileSync(resolve(adminRoot, path), 'utf8');
const html = (component, props = {}) => renderToStaticMarkup(createElement(component, props));
const srcFiles = () => readdirSync(resolve(adminRoot, 'src'), { recursive: true })
  .map((entry) => `src/${entry.split(sep).join('/')}`)
  .filter((path) => /\.(ts|tsx)$/.test(path));
const LINK_FAKE = 'scripts/fixtures/fe1-fake-next-link.mjs';
const prefetchValues = (markup) => [...markup.matchAll(/data-prefetch="([^"]*)"/g)].map((m) => m[1]);
// FE1_SECTION=C,D runs only those sections (for a red run of one test).
const only = (section) => !process.env.FE1_SECTION || process.env.FE1_SECTION.split(',').includes(section);

// --- A. Design-system primitives ----------------------------------------------
if (only('A')) {
  const uiFiles = srcFiles().filter((path) => path.startsWith('src/components/ui/'));
  assert.ok(uiFiles.length >= 24, `found ${uiFiles.length} ui files; expected the 19 ported and 5 admin-only primitives`);
  for (const path of uiFiles) {
    const source = read(path);
    assert.doesNotMatch(source, /next-intl|@\/i18n\/|@\/lib\/api\/|@\/components\/report\/|useTranslations|@\/lib\/match|@\/lib\/status/, `${path} uses no frontend-only module`);
    if (/['"]use client['"]/.test(source)) assert.match(source, /^'use client';\n/, `${path} declares 'use client' on its first line`);
  }

  const { load } = compileAdminSources({
    name: 'fe1-ui-primitives',
    sources: [
      'src/components/ui/status-badge.tsx', 'src/components/ui/stat-tile.tsx', 'src/components/ui/tab-nav.tsx',
      'src/components/ui/table-scroll.tsx', 'src/components/ui/empty-state.tsx', 'src/components/ui/error-state.tsx',
      'src/components/ui/page-skeletons.tsx', 'src/components/ui/theme-toggle.tsx', 'src/components/ui/confirm-dialog.tsx',
      'src/components/ui/toast.tsx', 'src/components/ui/sheet.tsx', 'src/components/ui/inline-feedback.tsx',
      'src/components/ui/kv-list.tsx', 'src/components/ui/panel-header.tsx', 'src/components/ui/input.tsx',
      'src/components/ui/select.tsx', 'src/components/ui/textarea.tsx', 'src/components/ui/button.tsx',
    ],
    fakes: { 'next/link': LINK_FAKE },
  });
  const ui = async (name) => load(`src/components/ui/${name}.tsx`);

  const { StatusBadge, statusTone } = await ui('status-badge');
  for (const [state, text, tone] of [
    ['healthy', 'Healthy', 'success'], ['watch', 'Watch', 'warning'],
    ['problem', 'Problem', 'danger'], ['unknown', 'Unknown', 'neutral'],
  ]) {
    const markup = html(StatusBadge, { state });
    assert.match(markup, new RegExp(`>${text}</span>`), `${state} is named in words, never by colour alone`);
    assert.match(markup, /<span aria-hidden="true" class="[^"]*rounded-full/, `${state}'s dot is decoration`);
    assert.equal(statusTone(state), tone);
  }

  const { StatTile } = await ui('stat-tile');
  const linked = html(StatTile, { label: 'Open jobs', value: '41', hint: '6 stale', href: '/analytics' });
  assert.match(linked, /<a\b[^>]*href="\/analytics"[^>]*data-prefetch="false"/, 'a linked tile is one link that never prefetches');
  assert.match(linked, />41<[\s\S]*>Open jobs<[\s\S]*>6 stale</, 'value, label, then hint');
  assert.doesNotMatch(html(StatTile, { label: 'Open jobs', value: '41' }), /<a\b/, 'a tile without href is not a link');

  const { TabNav } = await ui('tab-nav');
  const tabs = html(TabNav, {
    label: 'Inbox tabs',
    items: [
      { label: 'All', href: '/inbox?tab=all', count: 12, active: true },
      { label: 'Support', href: '/inbox?tab=support', active: false },
    ],
  });
  assert.match(tabs, /<nav aria-label="Inbox tabs"/);
  assert.match(tabs, /<a\b[^>]*href="\/inbox\?tab=all"[^>]*aria-current="page"|<a\b[^>]*aria-current="page"[^>]*href="\/inbox\?tab=all"/, 'the active tab is the current page');
  const supportTab = /<a\b[^>]*href="\/inbox\?tab=support"[^>]*>/.exec(tabs)[0];
  assert.doesNotMatch(supportTab, /aria-current/, 'only the active tab is current');
  assert.match(tabs, />12</, 'a tab shows its count');
  assert.deepEqual([...new Set(prefetchValues(tabs))], ['false'], 'tab links never prefetch');

  const { TableScroll } = await ui('table-scroll');
  const region = html(TableScroll, { label: 'Signups table', children: createElement('table') });
  assert.match(region, /<div role="region" aria-label="Signups table" tabindex="0" class="[^"]*overflow-x-auto/, 'a wide table scrolls inside its own focusable region');

  const { EmptyState } = await ui('empty-state');
  const empty = html(EmptyState, { title: 'No recent activity', body: 'Nothing yet.', action: { label: 'Open inbox', href: '/inbox' } });
  assert.match(empty, />No recent activity</);
  assert.match(empty, /<a\b[^>]*href="\/inbox"[^>]*data-prefetch="false"[^>]*>Open inbox<\/a>/, 'an empty-state link never prefetches');

  const { ErrorState } = await ui('error-state');
  const serverError = html(ErrorState, { kind: 'server' });
  assert.match(serverError, /role="alert"/);
  assert.match(serverError, />Something went wrong</);
  assert.match(serverError, />Something went wrong on our side\. Please try again in a few minutes\.</);
  assert.doesNotMatch(serverError, /<button/, 'no retry button without onRetry');
  assert.match(html(ErrorState, { kind: 'server', onRetry: () => {} }), /<button[^>]*>[\s\S]*Try again/, 'a retryable error offers Try again');
  assert.match(html(ErrorState, { kind: 'not_found', backHref: '/' }), />Not found<[\s\S]*<a\b[^>]*href="\/"[^>]*data-prefetch="false"[^>]*>Go back<\/a>/);

  const skeletons = await ui('page-skeletons');
  for (const name of ['ListPageSkeleton', 'DetailPageSkeleton', 'MetricRowSkeleton']) {
    const markup = html(skeletons[name]);
    if (name !== 'MetricRowSkeleton') assert.match(markup, /role="status"[\s\S]*<span class="sr-only">Loading<\/span>/, `${name} announces loading once`);
  }

  const theme = await ui('theme-toggle');
  assert.equal(theme.THEME_STORAGE_KEY, 'jale-admin-theme', 'the admin theme has its own storage key');
  const toggle = html(theme.ThemeToggle);
  assert.match(toggle, /aria-pressed="false"/, 'server and first client render agree: light until the effect reads the class');
  assert.match(toggle, /aria-label="Switch to dark theme"/);

  const { ConfirmDialog } = await ui('confirm-dialog');
  assert.equal(
    html(ConfirmDialog, { open: true, title: 'Deactivate', body: 'Sure?', confirmLabel: 'Deactivate', onConfirm: () => {}, onCancel: () => {} }),
    '',
    'dialogs render nothing on the server (portals mount in the browser)',
  );
  const { ToastProvider } = await ui('toast');
  assert.match(html(ToastProvider, { children: 'page' }), /aria-live="polite"/, 'the toast live region exists before the first toast');
  const { InlineFeedback, feedbackRole } = await ui('inline-feedback');
  assert.match(html(InlineFeedback, { tone: 'info', onDismiss: () => {}, children: 'Saved' }), /aria-label="Dismiss"/);
  assert.equal(feedbackRole('danger'), 'alert');
  const { KVList } = await ui('kv-list');
  assert.match(html(KVList, { items: [{ label: 'Role', value: 'Ops' }] }), />Role<[\s\S]*>Ops</);
  console.log('A. primitives: ok');
}

// --- B. Client helpers: admin fetch (K1.3), LocalTime forms, sign-out ---------
if (only('B')) {
  const { createHash } = await import('node:crypto');
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const time = await compileAdminSources({ name: 'fe1-local-time', sources: ['src/lib/local-time.ts'] }).load('src/lib/local-time.ts');

  // Pure time helpers. utcText's output is pinned by check-access-history-view too.
  const NOW = Date.parse('2026-10-14T12:00:00.000Z');
  const M = 60_000;
  const H = 60 * M;
  const D = 24 * H;
  const ago = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(time.utcText('2026-10-01T12:00:05.123Z'), '2026-10-01 12:00:05 UTC', 'utcText is unchanged');
  assert.equal(time.utcDateText('2026-10-02T23:30:00.000Z'), '2026-10-02 UTC');
  assert.equal(time.utcDateText('not a time'), 'not a time');
  assert.equal(time.utcTimeText('2026-10-02T14:30:59.000Z'), '14:30 UTC', 'time of day in UTC, to the minute');
  assert.equal(time.utcTimeText('2026-10-02T00:05:00.000Z'), '00:05 UTC');
  assert.equal(time.utcTimeText('not a time'), 'not a time');
  for (const [iso, expected] of [
    [ago(30_000), 'just now'], [new Date(NOW + 20_000).toISOString(), 'just now'],
    [ago(M), '1m ago'], [ago(5 * M + 59_000), '5m ago'], [ago(59 * M), '59m ago'],
    [ago(H), '1h ago'], [ago(3 * H + 40 * M), '3h ago'], [ago(D), '1d ago'], [ago(2 * D + 5 * H), '2d ago'],
    [new Date(NOW + 3 * H + 12 * M).toISOString(), 'in 3h 12m'], ['not a time', 'not a time'],
  ]) {
    assert.equal(time.relativeText(iso, NOW), expected, `relativeText(${iso})`);
  }
  for (const [ms, expected] of [
    [0, '0m'], [-5, '0m'], [59_999, '0m'], [Number.NaN, '0m'], [45 * M, '45m'],
    [3 * H, '3h 0m'], [3 * H + 12 * M, '3h 12m'], [28 * H, '1d 4h'], [3 * D + 30 * M, '3d 0h'],
  ]) {
    assert.equal(time.durationText(ms), expected, `durationText(${ms})`);
  }

  const helpers = compileAdminSources({
    name: 'fe1-client-helpers',
    sources: ['src/lib/admin-fetch.ts', 'src/components/LocalTime.tsx', 'src/components/shell/sign-out.ts'],
    fakes: { 'amazon-cognito-identity-js': 'scripts/fixtures/fe1-fake-cognito.mjs' },
  });

  // LocalTime: the server (and the first client render) show UTC text, so hydration matches.
  const { LocalTime } = await helpers.load('src/components/LocalTime.tsx');
  const at = '2026-10-01T12:00:00.000Z';
  assert.equal(html(LocalTime, { iso: at }), `<time dateTime="${at}">2026-10-01 12:00:00 UTC</time>`, 'datetime is unchanged');
  assert.equal(html(LocalTime, { iso: at, format: 'date' }), `<time dateTime="${at}">2026-10-01 UTC</time>`);
  assert.equal(html(LocalTime, { iso: at, format: 'time' }), `<time dateTime="${at}">12:00 UTC</time>`, 'time renders UTC text until hydration (no title yet)');
  assert.equal(
    html(LocalTime, { iso: ago(5 * M), format: 'relative', nowIso: new Date(NOW).toISOString() }),
    `<time dateTime="${ago(5 * M)}">5m ago</time>`,
    'relative renders against the server request time',
  );
  assert.equal(html(LocalTime, { iso: at, format: 'relative' }), `<time dateTime="${at}">2026-10-01 12:00:00 UTC</time>`, 'relative without nowIso falls back to the UTC text');

  // A fake browser for the fetch helper and the sign-out flow.
  const requests = [];
  let respond = () => new Response(null, { status: 204 });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return respond(url, init);
  };
  const assigned = [];
  globalThis.window = { location: { pathname: '/inbox/support/abc', search: '?tab=support&q=S-1', assign: (href) => assigned.push(href) } };
  const reset = () => { requests.length = 0; assigned.length = 0; };

  const fetchLib = await helpers.load('src/lib/admin-fetch.ts');
  assert.equal(await fetchLib.sha256Hex(''), sha(''), 'sha256Hex is the lowercase hex digest of the UTF-8 bytes');
  assert.equal(await fetchLib.sha256Hex('{"note":"ñ"}'), sha('{"note":"ñ"}'));
  assert.equal(
    fetchLib.expiredLoginHref({ pathname: '/inbox/support/abc', search: '?tab=support&q=S-1' }),
    '/login?next=%2Finbox%2Fsupport%2Fabc%3Ftab%3Dsupport%26q%3DS-1&reason=expired',
  );

  // POST with a body: one JSON string, hashed and sent as is.
  reset();
  respond = () => Response.json({ ok: true });
  const controller = new AbortController();
  assert.deepEqual(
    await fetchLib.adminFetchJson('/api/inbox-actions', { method: 'POST', body: { note: 'hi', n: 1 }, signal: controller.signal }),
    { kind: 'ok', status: 200, data: { ok: true } },
  );
  const post = requests[0];
  assert.equal(post.url, '/api/inbox-actions');
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.body, '{"note":"hi","n":1}');
  assert.equal(post.init.headers['x-amz-content-sha256'], sha('{"note":"hi","n":1}'), 'the hash is of the exact body sent');
  assert.equal(post.init.headers['content-type'], 'application/json');
  assert.equal(post.init.credentials, 'same-origin');
  assert.equal(post.init.signal, controller.signal);

  // DELETE without a body hashes the empty string and sends no content type.
  reset();
  respond = () => new Response(null, { status: 204 });
  assert.deepEqual(await fetchLib.adminFetchJson('/api/session', { method: 'DELETE' }), { kind: 'ok', status: 204, data: null });
  assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[0].init.headers['x-amz-content-sha256'], sha(''));
  assert.equal(requests[0].init.headers['content-type'], undefined);

  respond = () => new Response('not json', { status: 200 });
  assert.deepEqual(await fetchLib.adminFetchJson('/x', { method: 'POST', body: {} }), { kind: 'ok', status: 200, data: null });
  respond = () => Response.json({ ok: false, error: 'last_superadmin' }, { status: 409 });
  assert.deepEqual(await fetchLib.adminFetchJson('/x', { method: 'POST', body: {} }), { kind: 'error', status: 409, data: { ok: false, error: 'last_superadmin' } });

  // 401: one navigation to the expired sign-in, keeping the page the admin was on.
  reset();
  respond = () => Response.json({ error: 'session_expired' }, { status: 401 });
  assert.deepEqual(await fetchLib.adminFetchJson('/x', { method: 'POST', body: {} }), { kind: 'redirecting' });
  assert.deepEqual(assigned, ['/login?next=%2Finbox%2Fsupport%2Fabc%3Ftab%3Dsupport%26q%3DS-1&reason=expired']);
  reset();
  assert.deepEqual(
    await fetchLib.adminFetchJson('/api/session', { method: 'POST', body: {}, redirectOn401: false }),
    { kind: 'error', status: 401, data: { error: 'session_expired' } },
    'sign-in reads its own 401s',
  );
  assert.deepEqual(assigned, [], 'no redirect when the caller handles 401');

  respond = () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await fetchLib.adminFetchJson('/x', { method: 'POST', body: {} }), { kind: 'network' });

  // Sign-out: DELETE /api/session, then the SDK sign-out, then /login, whatever fails.
  const { signOutAdmin } = await helpers.load('src/components/shell/sign-out.ts');
  const AUTH = { userPoolId: 'us-east-1_TestPool1', clientId: 'test-client-id' };
  const signOutRun = async (setup) => {
    reset();
    globalThis.__adminCheck = { signOutLog: [] };
    respond = () => {
      globalThis.__adminCheck.signOutLog.push(['DELETE']);
      return new Response(null, { status: 204 });
    };
    setup();
    await signOutAdmin(globalThis.__adminCheck.auth ?? AUTH);
    return { log: globalThis.__adminCheck.signOutLog, assigned: [...assigned] };
  };
  let run = await signOutRun(() => {});
  assert.deepEqual(run.log, [['DELETE'], ['pool', AUTH.userPoolId, AUTH.clientId], ['sdk-signOut']], 'server session first, then the SDK');
  assert.deepEqual(run.assigned, ['/login']);
  assert.equal(requests[0].url, '/api/session');
  assert.equal(requests[0].init.method, 'DELETE');
  run = await signOutRun(() => { respond = () => Response.json({ error: 'session_expired' }, { status: 401 }); });
  assert.deepEqual(run.assigned, ['/login'], 'an ended session still signs out to /login, never the expired link');
  run = await signOutRun(() => { respond = () => { throw new TypeError('offline'); }; });
  assert.deepEqual(run.log, [['pool', AUTH.userPoolId, AUTH.clientId], ['sdk-signOut']], 'offline: the SDK still signs out');
  assert.deepEqual(run.assigned, ['/login']);
  run = await signOutRun(() => { globalThis.__adminCheck.cognitoThrows = true; });
  assert.deepEqual(run.assigned, ['/login'], 'an SDK error still lands on /login');
  run = await signOutRun(() => { globalThis.__adminCheck.auth = { userPoolId: '', clientId: '' }; });
  assert.deepEqual(run.log, [['DELETE']], 'no pool without ids');
  assert.deepEqual(run.assigned, ['/login']);

  delete globalThis.window;
  delete globalThis.__adminCheck;
  console.log('B. client helpers: ok');
}

// --- C. T2: the console shell ------------------------------------------------
if (only('C')) {
  // On the old code the root layout still drew the top nav (AdminNav).
  assert.doesNotMatch(read('src/app/layout.tsx'), /AdminNav/, 'the console shell (sidebar and top bar) replaced the top nav in the root layout');

  process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID = 'us-east-1_ShellPool1';
  process.env.NEXT_PUBLIC_ADMIN_CLIENT_ID = 'shell-client-id';
  process.env.NEXT_PUBLIC_ADMIN_HOSTED_DOMAIN = 'admin-hosted.example.test';
  process.env.NEXT_PUBLIC_ADMIN_REGION = 'test-region-9';

  const shell = compileAdminSources({
    name: 'fe1-shell',
    sources: [
      'src/app/(console)/layout.tsx', 'src/components/shell/nav-items.ts', 'src/components/shell/badge-text.ts',
      'src/components/shell/role-label.ts', 'src/components/shell/initials.ts',
    ],
    fakes: {
      'next/link': LINK_FAKE,
      'next/navigation': 'scripts/fakes/next-navigation.mjs',
      'amazon-cognito-identity-js': 'scripts/fixtures/fe1-fake-cognito.mjs',
      'src/lib/server/session.ts': 'scripts/fakes/session.mjs',
      'src/lib/server/admin-inbox.ts': 'scripts/fixtures/fe1-fake-admin-inbox.mjs',
    },
  });
  const { default: ConsoleLayout } = await shell.load('src/app/(console)/layout.tsx');
  const nav = await shell.load('src/components/shell/nav-items.ts');
  const badge = await shell.load('src/components/shell/badge-text.ts');
  const { roleLabel } = await shell.load('src/components/shell/role-label.ts');
  const { emailInitials } = await shell.load('src/components/shell/initials.ts');

  const counts = (waitingOnUs) => ({
    waitingOnUs, support: 0, reports: 0, lockouts: 0, deliveryIssues: 0, unreadSupport: 0,
    oldestWaiting: { support: null, reports: null, lockouts: null }, newSinceLastVisit: null,
  });
  const renderShell = async ({ role = 'admin_ops', pathname = '/', inbox = counts(7), countsError, email = 'ops-admin@example.test' } = {}) => {
    globalThis.__adminCheck = { session: { preview: true, sub: 'check-admin', email, role, groups: [role] }, pathname, counts: inbox, countsError };
    const tree = await ConsoleLayout({ children: createElement('p', { id: 'page-body' }, 'Page body') });
    return renderToStaticMarkup(tree);
  };
  const tagsFor = (markup, href) => [...markup.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(`href="${href}"`));
  const current = (markup, href) => tagsFor(markup, href).filter((tag) => tag.includes('aria-current="page"')).length;
  const navHrefs = (markup) => /<nav aria-label="Admin">([\s\S]*?)<\/nav>/.exec(markup)[1].match(/href="[^"]*"/g).map((h) => h.slice(6, -1));

  // Admins and Security are for superadmins only (K1.4).
  assert.deepEqual(navHrefs(await renderShell({ role: 'admin_ops' })), ['/', '/inbox', '/analytics']);
  assert.deepEqual(navHrefs(await renderShell({ role: 'admin_readonly' })), ['/', '/inbox', '/analytics']);
  assert.deepEqual(navHrefs(await renderShell({ role: 'admin_superadmin' })), ['/', '/inbox', '/analytics', '/admins', '/security']);

  // The badge is waitingOnUs, capped at 99+, with the full number for screen readers.
  let markup = await renderShell({ inbox: counts(120) });
  assert.equal((markup.match(/<span aria-hidden="true">99\+<\/span>/g) ?? []).length, 2, 'the sidebar Inbox entry and the mobile menu button both show 99+');
  assert.equal((markup.match(/<span class="sr-only"> 120 waiting<\/span>/g) ?? []).length, 2);
  markup = await renderShell({ inbox: counts(7) });
  assert.match(markup, /<span aria-hidden="true">7<\/span><span class="sr-only"> 7 waiting<\/span>/);
  for (const [label, options] of [['null counts', { inbox: null }], ['zero waiting', { inbox: counts(0) }], ['a failing count', { countsError: new Error('count query failed') }]]) {
    markup = await renderShell(options);
    assert.doesNotMatch(markup, /data-inbox-badge/, `${label}: no badge`);
    assert.match(markup, /id="page-body"/, `${label}: the page still renders inside the shell`);
  }

  // The skip link comes first; one main landmark holds the page.
  markup = await renderShell();
  assert.match(/<(a|button)\b[^>]*>[^<]*/.exec(markup)[0], /^<a href="#main"[^>]*>Skip to content$/, 'the skip link is the first focusable element');
  assert.equal((markup.match(/<main\b/g) ?? []).length, 1);
  assert.match(markup, /<main id="main" tabindex="-1"[^>]*>\s*<p id="page-body">/, 'the page renders inside <main id="main">');

  // Every next/link in the shell asks for prefetch={false}.
  const prefetch = prefetchValues(markup);
  assert.ok(prefetch.length >= 5, `found ${prefetch.length} shell links`);
  assert.deepEqual([...new Set(prefetch)], ['false'], 'shell links never prefetch');

  // Active state by prefix; Home on '/' only.
  markup = await renderShell({ pathname: '/inbox/support/00000000-0000-4000-8000-000000000001' });
  assert.equal(current(markup, '/inbox'), 1, 'Inbox is current below /inbox');
  assert.equal(current(markup, '/'), 0, 'Home is current on / only');
  assert.equal(current(await renderShell({ pathname: '/' }), '/'), 1);
  assert.equal(current(await renderShell({ pathname: '/analytics/ops' }), '/analytics'), 1);
  assert.equal(current(await renderShell({ pathname: '/reports/settings' }), '/inbox'), 1, 'Report settings belongs to the Inbox');
  assert.equal(current(await renderShell({ pathname: '/inbox-archive' }), '/inbox'), 0, 'a prefix match needs the slash');

  // Footer: initials, role label, theme and sign-out; a long email truncates.
  markup = await renderShell();
  assert.match(markup, />OA<\/span>/);
  assert.match(markup, />Ops<\/span>/);
  assert.match(markup, /<button type="button"[^>]*>[\s\S]*?Dark mode<\/button>/);
  assert.match(markup, /<button type="button"[^>]*>[\s\S]*?Sign out<\/button>/);
  assert.match(markup, /aria-expanded="false"[^>]*>[\s\S]*?Menu/, 'below 1024px a menu button opens the nav');
  markup = await renderShell({ email: `${'very-long-admin-name'.repeat(4)}@example.test` });
  assert.match(markup, /<span class="truncate[^"]*"[^>]*>very-long-admin-name/, 'a long email truncates instead of widening the sidebar');
  assert.match(markup, /class="flex min-w-0 flex-col"/);
  assert.doesNotMatch(markup, /admin-hosted\.example\.test|test-region-9/, 'no hosted domain or region in the shell');

  // Pure helpers.
  assert.deepEqual([0, 7, 99, 100, 120].map(badge.inboxBadgeText), ['0', '7', '99', '99+', '99+']);
  assert.equal(badge.inboxBadgeSrText(120), '120 waiting');
  assert.deepEqual(['admin_readonly', 'admin_ops', 'admin_superadmin'].map(roleLabel), ['Read-only', 'Ops', 'Superadmin']);
  assert.deepEqual(
    ['ops-admin@example.test', 'pat@example.test', 'a.b.c@example.test', '', 'x@'].map(emailInitials),
    ['OA', 'PA', 'AB', '?', 'X'],
  );
  assert.deepEqual(nav.visibleNavItems('admin_ops').map((item) => item.label), ['Home', 'Inbox', 'Analytics']);
  delete globalThis.__adminCheck;
  console.log('C. T2 shell: ok');
}

// --- D. T3: nothing about the sign-in setup reaches the browser ---------------
if (only('D')) {
  const clientFiles = srcFiles().filter((path) => /^'use client';/.test(read(path)));
  // The old AdminNav and AdminLoginForm took the whole AdminAuthConfig (pool,
  // client, region, hosted domain) as a client prop.
  for (const path of clientFiles) {
    assert.doesNotMatch(read(path), /\bAdminAuthConfig\b|getAdminAuthConfig|hostedDomain/, `${path} is a client component and never sees the server auth config (K1.1)`);
  }
  assert.ok(clientFiles.length >= 15, `found ${clientFiles.length} client components`);

  // The props types, walked: no client component's props carry the hosted
  // domain or the region at any depth of an admin-declared shape.
  const ts = (await import('typescript')).default;
  const srcRoot = resolve(adminRoot, 'src').split(sep).join('/');
  const program = ts.createProgram(clientFiles.map((path) => resolve(adminRoot, path)), {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
    jsx: ts.JsxEmit.ReactJSX,
    paths: { '@/*': [`${srcRoot}/*`] },
  });
  const checker = program.getTypeChecker();
  const FORBIDDEN = new Set(['hostedDomain', 'region']);
  const visited = new Set();
  const leaks = [];
  const walk = (type, path, depth) => {
    if (depth > 4) return;
    if (type.isUnion() || type.isIntersection()) {
      for (const member of type.types) walk(member, path, depth);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object)) return;
    for (const prop of checker.getPropertiesOfType(type)) {
      const at = `${path}.${prop.getName()}`;
      visited.add(at);
      if (FORBIDDEN.has(prop.getName())) leaks.push(at);
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
      if (!declaration || !declaration.getSourceFile().fileName.startsWith(srcRoot)) continue;
      const propType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(prop, declaration));
      if (propType.getCallSignatures().length > 0) continue;
      walk(propType, at, depth + 1);
    }
  };
  for (const path of clientFiles) {
    const sourceFile = program.getSourceFile(resolve(adminRoot, path));
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (!symbol.valueDeclaration) continue;
      for (const signature of checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration).getCallSignatures()) {
        const [props] = signature.getParameters();
        if (!props) continue;
        const propsType = checker.getTypeOfSymbolAtLocation(props, props.valueDeclaration ?? symbol.valueDeclaration);
        walk(checker.getNonNullableType(propsType), exported.getName(), 0);
      }
    }
  }
  for (const expected of ['AdminLoginForm.authConfig.userPoolId', 'AdminSidebar.authConfig.clientId', 'SignOutButton.authConfig.userPoolId']) {
    assert.ok(visited.has(expected), `the props walk reached ${expected}`);
  }
  assert.deepEqual(leaks, [], 'no client component prop carries the hosted domain or the region');

  // The login page: the client-safe props only, and no configuration text.
  process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID = 'us-east-1_LoginPool1';
  process.env.NEXT_PUBLIC_ADMIN_CLIENT_ID = 'login-client-id';
  process.env.NEXT_PUBLIC_ADMIN_HOSTED_DOMAIN = 'admin-hosted.example.test';
  process.env.NEXT_PUBLIC_ADMIN_REGION = 'test-region-9';
  const login = compileAdminSources({
    name: 'fe1-login',
    sources: ['src/app/(auth)/login/page.tsx', 'src/app/(auth)/layout.tsx'],
    fakes: {
      'src/components/AdminLoginForm.tsx': 'scripts/fixtures/fe1-fake-login-form.mjs',
      'src/lib/server/device-trust.ts': 'scripts/fixtures/fe1-fake-device-trust.mjs',
    },
  });
  const { default: LoginPage } = await login.load('src/app/(auth)/login/page.tsx');
  const renderLogin = async (params, deviceTrust = true) => {
    globalThis.__adminCheck = { deviceTrust, loginFormProps: [] };
    return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
  };
  const plain = await renderLogin({});
  const [props] = globalThis.__adminCheck.loginFormProps;
  assert.deepEqual(Object.keys(props).sort(), ['authConfig', 'deviceTrustEnabled'], 'the form gets the client-safe config and the trust flag only');
  assert.deepEqual(Object.keys(props.authConfig).sort(), ['clientId', 'userPoolId']);
  assert.equal(props.deviceTrustEnabled, true);
  for (const text of ['Auth config', 'Hosted domain', 'User pool', 'Client ID', 'Region', 'Not configured', 'admin-hosted.example.test', 'test-region-9', 'us-east-1_LoginPool1', 'login-client-id']) {
    assert.ok(!plain.includes(text), `the sign-in page shows no configuration (${text})`);
  }
  assert.match(plain, />Admin sign-in<\/h1>/);
  assert.match(plain, />Code required</);
  assert.match(plain, />For Jale staff only\. Every sign-in is logged\.</);
  assert.doesNotMatch(plain, /Your session ended/);
  assert.match(await renderLogin({ reason: 'expired' }), /role="status"[^>]*>[\s\S]*Your session ended\. Sign in again to continue\./, 'reason=expired shows the K1.3 notice');
  for (const reason of ['other', ['expired', 'x'], undefined]) {
    assert.doesNotMatch(await renderLogin({ reason }), /Your session ended/, `reason=${JSON.stringify(reason)} shows no notice`);
  }
  await renderLogin({}, false);
  assert.equal(globalThis.__adminCheck.loginFormProps[0].deviceTrustEnabled, false, 'the trust flag comes from isDeviceTrustEnabled()');
  delete globalThis.__adminCheck;
  console.log('D. T3 client props and login page: ok');
}

// --- E. T6: the theme applies before first paint, without inline HTML ---------
if (only('E')) {
  const rootLayout = read('src/app/layout.tsx');
  assert.match(
    rootLayout,
    /<head>\s*<script src="\/theme-init\.js" \/>\s*<\/head>/,
    'the theme script is the first and only thing the layout puts in <head>: parser-blocking, so no page paints in the wrong theme',
  );
  assert.match(
    rootLayout,
    /<html lang="en" className=\{lexend\.variable\} suppressHydrationWarning>/,
    'the script changes the <html> class before hydration, so <html> opts out of that one mismatch',
  );
  const { default: vm } = await import('node:vm');
  const code = read('public/theme-init.js');
  const runInit = ({ stored = null, osDark = false, storageThrows = false, noMatchMedia = false } = {}) => {
    const classes = new Set();
    const reads = [];
    const localStorage = {
      getItem: (key) => {
        reads.push(key);
        if (storageThrows) throw new Error('storage blocked');
        return stored;
      },
    };
    const window = {
      localStorage,
      matchMedia: noMatchMedia ? undefined : (query) => ({ matches: osDark && query === '(prefers-color-scheme: dark)' }),
    };
    const document = { documentElement: { classList: { add: (name) => classes.add(name) } } };
    vm.runInNewContext(code, { window, localStorage, document });
    return { dark: classes.has('dark'), reads };
  };
  assert.deepEqual(runInit({ stored: 'dark' }), { dark: true, reads: ['jale-admin-theme'] }, 'a saved dark choice wins over a light OS');
  assert.equal(runInit({ stored: 'light', osDark: true }).dark, false, 'a saved light choice wins over a dark OS');
  assert.equal(runInit({ osDark: true }).dark, true, 'no saved choice follows a dark OS');
  assert.equal(runInit({ osDark: false }).dark, false, 'no saved choice follows a light OS');
  assert.equal(runInit({ stored: 'sepia', osDark: true }).dark, false, 'an unknown saved value reads as light, as in the app');
  assert.equal(runInit({ storageThrows: true, osDark: true }).dark, false, 'blocked storage: no throw, light');
  assert.equal(runInit({ noMatchMedia: true }).dark, false, 'no matchMedia: no throw, light');
  assert.match(read('src/components/ui/theme-toggle.tsx'), /export const THEME_STORAGE_KEY = 'jale-admin-theme';/, 'the toggle writes the key the script reads');
  assert.doesNotMatch(code, /jale-theme'/, "the console keeps its own choice, apart from the app's key");
  for (const path of srcFiles()) {
    assert.doesNotMatch(read(path), /dangerouslySetInnerHTML/, `${path} renders text only`);
  }
  assert.match(read('Dockerfile'), /^COPY --from=builder --chown=nextjs:nodejs \/app\/public \.\/public$/m, 'the image ships public/, where theme-init.js lives');
  console.log('E. T6 theme script: ok');
}

// --- F. Fallback states: not found, loading, error, global error ---------------
if (only('F')) {
  // The 404 for unmatched URLs. On the old code it was the pre-Tailwind hero
  // with "Back to dashboard".
  const rootNotFound = compileAdminSources({ name: 'fe1-not-found', sources: ['src/app/not-found.tsx'], fakes: { 'next/link': LINK_FAKE } });
  const { default: NotFound } = await rootNotFound.load('src/app/not-found.tsx');
  const notFound = html(NotFound);
  assert.match(notFound, /<a\b[^>]*href="\/"[^>]*data-prefetch="false"[^>]*>Back to Home<\/a>/, 'the 404 leads back to Home, without prefetch');
  assert.match(notFound, /<main id="main"/, 'the standalone 404 has its own main landmark');
  assert.match(notFound, /<h1[^>]*>That admin page does not exist\.<\/h1>/);
  assert.doesNotMatch(notFound, /class="(hero|badge|button)\b/, 'no legacy classes');

  const states = compileAdminSources({
    name: 'fe1-states',
    sources: ['src/app/(console)/not-found.tsx', 'src/app/(console)/loading.tsx', 'src/app/(console)/error.tsx', 'src/app/global-error.tsx'],
    fakes: { 'next/link': LINK_FAKE },
  });
  const { default: ConsoleNotFound } = await states.load('src/app/(console)/not-found.tsx');
  const consoleNotFound = html(ConsoleNotFound);
  assert.match(consoleNotFound, />That admin page does not exist\.</);
  assert.doesNotMatch(consoleNotFound, /<main\b/, 'inside the shell the 404 adds no second main');

  const { default: Loading } = await states.load('src/app/(console)/loading.tsx');
  const loading = html(Loading);
  assert.match(loading, /role="status"[\s\S]*<span class="sr-only">Loading<\/span>/, 'loading uses the skeletons and is announced');
  assert.doesNotMatch(loading, /<main\b/);

  // The error boundary shows a retry and logs nothing: an error can carry
  // query text or record values, and the server logged it under its digest.
  const { default: ConsoleError } = await states.load('src/app/(console)/error.tsx');
  const failure = Object.assign(new Error('select failed for ops-admin@example.test'), { digest: 'digest-check-1' });
  const { result: errorMarkup, lines } = await captureConsole(() => html(ConsoleError, { error: failure, reset: () => {} }));
  assert.deepEqual(lines, { log: [], error: [] }, 'the error boundary logs nothing');
  assert.match(errorMarkup, /role="alert"/);
  assert.match(errorMarkup, />Something went wrong</);
  assert.match(errorMarkup, /<button[^>]*>[\s\S]*Try again/, 'the error boundary offers a retry');
  assert.doesNotMatch(errorMarkup, /ops-admin@example\.test|select failed|digest-check-1/, 'the error message never reaches the page');
  assert.doesNotMatch(read('src/app/(console)/error.tsx'), /console\.|useEffect/, 'no logging hook in the error boundary');

  const { default: GlobalError } = await states.load('src/app/global-error.tsx');
  const globalError = html(GlobalError, { error: failure, reset: () => {} });
  assert.match(globalError, /<html lang="en">[\s\S]*<body\b/, 'global-error brings its own document');
  assert.match(globalError, />Something went wrong</);
  assert.match(globalError, /<button type="button"[^>]*>Try again<\/button>/);
  assert.doesNotMatch(globalError, /ops-admin@example\.test|digest-check-1/);
  assert.doesNotMatch(read('src/app/global-error.tsx'), /import '\.\/[\w-]+\.css'/, 'no stylesheet import: inline styles survive a failed stylesheet');
  console.log('F. fallback states: ok');
}
