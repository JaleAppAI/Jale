// Admin UI contract: the shell (FE-1).
// The console shell (layouts, sidebar, login page), the single stylesheet
// (globals.css; legacy.css was retired in sprint 28 phase 2), next.config.mjs
// (CSP), Home, LocalTime, and the app-wide scans: no dangerouslySetInnerHTML,
// pages with personal data load through recorded loaders and never read the
// pool, and every Link is imported as Link and never prefetches.
// Split out of check-ui-contract.mjs in sprint 28 step 0.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { read, root } from './lib/ui-contract-helpers.mjs';

const nextConfig = read('next.config.mjs');
const dashboardPage = read('src/app/(console)/page.tsx');
const localTime = read('src/components/LocalTime.tsx');

// --- The Reports inbox: the shell's part -----------------------------------
// No raw HTML anywhere: report words and every other text render as text.
for (const entry of readdirSync(resolve(root, 'src'), { recursive: true })) {
  if (!/\.(ts|tsx)$/.test(entry)) continue;
  assert.doesNotMatch(read(`src/${entry}`), /dangerouslySetInnerHTML/, `src/${entry} renders text only`);
}

assert.match(nextConfig, /"img-src 'self' data:"/, 'the admin CSP is unchanged: screenshots open by navigation');

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

// LocalTime: times switch to the viewer's zone after hydration.
assert.match(localTime, /^'use client';/);
assert.match(localTime, /useSyncExternalStore/, 'times switch to the viewer zone after hydration, with no mismatch');
assert.match(localTime, /<time dateTime=\{iso\}/, 'times are machine-readable');

console.log('admin UI shell contract checks passed');

// --- Sprint 28 FE-1: design system -------------------------------------------
const globalsCss = read('src/app/globals.css');
assert.match(globalsCss, /^@import "tailwindcss";\n/, 'globals.css is the Tailwind v4 entry');
assert.doesNotMatch(globalsCss, /@import url\(/, 'globals.css loads no remote stylesheet: the CSP blocks it, and next/font self-hosts Lexend');
assert.match(read('postcss.config.mjs'), /'@tailwindcss\/postcss': \{\}/, 'Tailwind v4 runs through PostCSS');
const rootLayoutSource = read('src/app/layout.tsx');
assert.match(rootLayoutSource, /import \{ Lexend \} from 'next\/font\/google';/, 'Lexend comes from next/font (self-hosted)');
assert.match(rootLayoutSource, /variable: '--font-lexend'/, 'the font is exposed as --font-lexend');
assert.match(rootLayoutSource, /<html lang="en" className=\{lexend\.variable\}/, 'the font variable sits on <html>');

// --- Sprint 28 FE-1: the console shell (replaces the AdminNav and root-layout pins) ---
const consoleLayout = read('src/app/(console)/layout.tsx');
const authLayout = read('src/app/(auth)/layout.tsx');
const navItems = read('src/components/shell/nav-items.ts');
const navList = read('src/components/shell/AdminNavList.tsx');
assert.equal(existsSync(resolve(root, 'src/components/AdminNav.tsx')), false, 'the console shell replaced AdminNav');
assert.doesNotMatch(read('src/app/layout.tsx'), /getCurrentAdminSession|getProblemReportCounts|getInboxCounts/, 'the root layout reads no session and no count: the sign-in page needs neither');
assert.match(consoleLayout, /const session = await requireAdminSession\(\);/, 'the shell renders only for a signed-in admin (each page checks again)');
assert.equal((consoleLayout.match(/getInboxCounts\(/g) ?? []).length, 1, 'the layout reads the inbox count once per request (K2.1)');
assert.match(consoleLayout, /getInboxCounts\(session\)\.catch\(\(\) => null\)/, 'a count failure hides the badge and never takes the console down');
assert.doesNotMatch(consoleLayout, /getProblemReportCounts|listProblemReports\(|loadInbox\(/, 'the badge never counts a page of rows');
assert.match(consoleLayout, /<AdminSidebar[^>]*role=\{session\.role\}/, 'the layout passes the role to the sidebar');
assert.match(consoleLayout, /getAdminClientAuthConfig\(\)/, 'only the client-safe auth config reaches the shell (K1.1)');
assert.doesNotMatch(consoleLayout + authLayout, /getAdminAuthConfig\(/, 'no layout reads the full auth config');
assert.match(consoleLayout, /<main id="main"/, 'the console layout owns the one main landmark, the skip link target');
assert.doesNotMatch(authLayout, /AdminSidebar|AdminTopBar|getInboxCounts|requireAdminSession/, 'the sign-in page has no shell and reads no session');
for (const [href, label] of [['/', 'Home'], ['/inbox', 'Inbox'], ['/analytics', 'Analytics'], ['/admins', 'Admins'], ['/security', 'Security']]) {
  assert.match(navItems, new RegExp(`href: '${href.replace(/\//g, '\\/')}', label: '${label}'`), `the nav links ${label}`);
}
assert.match(navItems, /href: '\/admins', label: 'Admins'[^}]*superadminOnly: true/, 'Admins is for superadmins only (K1.4)');
assert.match(navItems, /href: '\/security', label: 'Security'[^}]*superadminOnly: true/, 'Security is for superadmins only (K1.4)');
assert.doesNotMatch(navItems, /href: '\/(cases|reports|verifications|access-history|audit)'/, 'the nav never links a retired page');
assert.match(navList, /<Link\b[^>]*\bprefetch=\{false\}[^>]*>/, 'the nav link never prefetches');
assert.doesNotMatch(navItems + navList, /prefetch\?:|prefetch: false|prefetch=\{prefetch\}/, 'no nav entry chooses its own prefetch');
assert.match(navList, /focus-visible:ring-2/, 'nav links show a visible keyboard focus ring');
assert.match(read('src/components/ui/button.tsx'), /focus-visible:shadow-\[var\(--shadow-focus\)\]/, 'buttons show the token focus ring');
const loginPage = read('src/app/(auth)/login/page.tsx');
assert.match(loginPage, /<AdminLoginForm authConfig=\{getAdminClientAuthConfig\(\)\} deviceTrustEnabled=\{isDeviceTrustEnabled\(\)\} \/>/, 'the login page passes exactly the K1.1/K1.2 props (00-FE-INTERFACES §4)');
assert.doesNotMatch(loginPage, /getAdminAuthConfig|hostedDomain|Not configured/, 'the login page shows no configuration');

// --- Access records: pages never read the database themselves -----------------
// Every page that shows personal data loads it through a recorded loader,
// which records what it shows before COMMIT; a page that reached the pool
// would show data with no record. Sprint 28 replaced the fixed page table with
// this walk, so pages can move between lanes without editing this file:
//  - no page or layout imports the pool or runs SQL;
//  - every console page gates on an admin session first (redirect-only stubs excepted);
//  - every recorded loader (load*) is called with that session first.
// The page-specific loader literals are pinned in each owning lane's file.
const appFiles = readdirSync(resolve(root, 'src/app'), { recursive: true })
  .map((entry) => `src/app/${entry.split(sep).join('/')}`)
  .filter((path) => /(^|\/)(page|layout)\.tsx$/.test(path) && !path.startsWith('src/app/api/'));
const consolePages = appFiles.filter((path) => path.startsWith('src/app/(console)/') && path.endsWith('/page.tsx'));
assert.ok(consolePages.length >= 8, `the page walk found ${consolePages.length} console pages; expected at least 8`);
for (const path of appFiles) {
  assert.doesNotMatch(read(path), /getAdminDbPool|@\/lib\/server\/db['"]|\.query\(|\bSELECT\b/, `${path} never reads the database itself`);
}
for (const path of consolePages) {
  const source = read(path);
  const redirectOnly = /\bredirect\(/.test(source) && !/@\/lib\/server\//.test(source);
  if (redirectOnly) continue;
  assert.match(source, /await requireAdminSession\(\)/, `${path} gates on an admin session before any read`);
  assert.doesNotMatch(source, /\bload[A-Z]\w*\((?!session\b)/, `${path} passes the admin session to every recorded loader`);
}

// --- Sprint 28 FE-1: Home (K2.1, K2.2, K3.4) ------------------------------------
assert.match(dashboardPage, /export default async function HomePage\(\) \{\n  const session = await requireAdminSession\(\);\n/, 'Home gates on an admin session before any read');
assert.doesNotMatch(dashboardPage, /loadAdminDashboard|getAdminDbPool|@\/lib\/server\/db['"]/, 'Home reads the K2/K3 loaders, never the old dashboard read or the pool');
const homeWaves = [...dashboardPage.matchAll(/Promise\.allSettled\(\[([\s\S]*?)\]\)/g)].map((m) => (m[1].match(/\b\w+\(/g) ?? []).length);
assert.deepEqual(homeWaves, [3, 1], 'Home reads in two waves of at most three (pool cap, K3.0)');
for (const call of ['getInboxCounts(session)', 'getHomeMetrics()', 'getSystemHealth()', 'loadRecentActivity(session)']) {
  assert.ok(dashboardPage.includes(call), `Home calls ${call}`);
}
const homeSources = readdirSync(resolve(root, 'src/components/home')).map((file) => read(`src/components/home/${file}`)).join('\n') + dashboardPage;
assert.doesNotMatch(homeSources, /toLocaleString\(\)|toLocaleTimeString\(|toLocaleDateString\(/, 'Home renders no server-zone dates');
assert.match(homeSources, /<LocalTime iso=\{item\.at\} format="relative" nowIso=\{nowIso\} \/>/, 'activity times are relative, through LocalTime');
assert.doesNotMatch(homeSources, /'use client'/, 'Home and its sections are server components');

// --- Sprint 28 phase 2: one stylesheet, one main ---------------------------------
assert.equal(existsSync(resolve(root, 'src/app/legacy.css')), false, 'the pre-Tailwind stylesheet is retired');
assert.doesNotMatch(read('src/app/layout.tsx'), /legacy\.css/, 'the root layout loads globals.css only');
const MAIN_OWNERS = ['src/app/(console)/layout.tsx', 'src/app/(auth)/layout.tsx', 'src/app/not-found.tsx', 'src/app/global-error.tsx'];
// Comments may mention <main>; only code opens one.
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const mainUsers = readdirSync(resolve(root, 'src'), { recursive: true })
  .map((entry) => `src/${entry.split(sep).join('/')}`)
  .filter((path) => path.endsWith('.tsx') && /<main\b/.test(withoutComments(read(path))))
  .sort();
assert.deepEqual(mainUsers, [...MAIN_OWNERS].sort(), 'only the layouts (and the standalone 404 and global error) render <main>: pages sit inside the shell\'s one main landmark');
