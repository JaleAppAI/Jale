// Admin UI contract: the Inbox, support conversation, report and lockout
// views (FE-2), the report settings page, ReportActionsPanel, ReportFilters
// and CopyButton. Split out of check-ui-contract.mjs in sprint 28 step 0. FE-2
// retired the case console and the lockout list in sprint 28: their URLs
// redirect into the Inbox (FE-1), and case actions moved to POST
// /api/inbox-actions (K2.7, BE-2b).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { read, root } from './lib/ui-contract-helpers.mjs';

// --- FE-2 helpers --------------------------------------------------------------
const fe2Has = (path) => existsSync(resolve(root, path));
function fe2Source(path) {
  assert.ok(fe2Has(path), `${path} must exist`);
  return read(path);
}
function fe2Files(dir) {
  if (!fe2Has(dir)) return [];
  return readdirSync(resolve(root, dir), { recursive: true })
    .filter((entry) => /\.tsx?$/.test(entry))
    .map((entry) => `${dir}/${entry}`);
}
/** A page that shows personal data: session first, its recorded loader with that session, never the pool, server-only. */
function fe2AssertRecordedPage(path, loaderCall, { params = false, searchParams = false } = {}) {
  const source = fe2Source(path);
  assert.match(source, /const session = await requireAdminSession\(\);/, `${path} gates on an admin session first`);
  assert.ok(source.includes(loaderCall), `${path} loads through its recorded loader: ${loaderCall}`);
  assert.doesNotMatch(source, /getAdminDbPool|@\/lib\/server\/db['"]/, `${path} never reads the pool directly`);
  assert.doesNotMatch(source, /^'use client'/m, `${path} stays a server component`);
  assert.doesNotMatch(source, /generateMetadata/, `${path} never runs its recorded loader twice`);
  if (params) {
    assert.match(source, /params:\s*Promise<\{\s*id:\s*string;?\s*\}>/, `${path} types params as a Promise (Next 16)`);
    assert.match(source, /await params/, `${path} awaits params`);
    assert.doesNotMatch(source, /\bparams\.id\b/, `${path} never reads .id off the un-awaited params`);
  }
  if (searchParams) {
    assert.match(source, /searchParams:\s*Promise</, `${path} types searchParams as a Promise (Next 16)`);
    assert.match(source, /await searchParams/, `${path} awaits searchParams`);
  }
}

// --- Retired by FE-2 -------------------------------------------------------------
const FE2_RETIRED = [
  'src/app/(console)/cases/page.tsx',
  'src/app/(console)/cases/[id]/page.tsx',
  'src/app/(console)/verifications/page.tsx',
  'src/app/(console)/verifications/[id]/page.tsx',
  'src/components/AdminActionsPanel.tsx',
  'src/app/actions.ts',
];
for (const retired of FE2_RETIRED) {
  assert.equal(fe2Has(retired), false, `${retired} is retired: its URL redirects into the Inbox`);
}

// --- Reports block ---
const reportDetail = read('src/app/(console)/inbox/reports/[id]/page.tsx');
const reportBody = read('src/components/inbox/ReportDetail.tsx');
const reportSettings = read('src/app/(console)/reports/settings/page.tsx');
const reportPanel = read('src/components/inbox/ReportActions.tsx');
const copyButton = read('src/components/CopyButton.tsx');

for (const [label, source] of [
  ['src/app/(console)/inbox/reports/[id]/page.tsx', reportDetail],
  ['src/app/(console)/reports/settings/page.tsx', reportSettings],
]) {
  assert.match(source, /const session = await requireAdminSession\(\)/, `${label} gates on an admin session`);
  assert.doesNotMatch(source, /'use client'/, `${label} stays a server component`);
}
assert.doesNotMatch(reportBody, /'use client'/, 'ReportDetail stays a server component');

// Every read goes through its recorded read model.
fe2AssertRecordedPage('src/app/(console)/inbox/reports/[id]/page.tsx', 'getProblemReport(session, id)', { params: true });
assert.match(reportDetail, /notFound\(\)/, 'an unknown report is a 404');
assert.match(reportSettings, /canReport\(session\.role, 'view_settings'\)/, 'the settings page is for superadmins');
assert.match(reportSettings, /recordReportSettingsDenied\(session\)/, 'a refused settings view is a recorded attempt');
assert.match(reportSettings, /getProblemReportSettings\(session\)/, 'the settings read is recorded');
assert.match(reportSettings, /getAdminAuthConfig\(\)\.hostedDomain/, 'the dashboard address defaults to the admin app origin');
assert.match(reportSettings, /from '@\/components\/inbox\/ReportActions'/, 'the settings form moved with the report actions');

// The action controls come from the policy, so read-only roles never get them.
for (const capability of ['reveal_contact', 'view_screenshot', 'set_status', 'set_note']) {
  assert.match(reportBody, new RegExp(`canReport\\(role, '${capability}'\\)`), `the report view gates ${capability} on the policy`);
}

// The words are plain text in a wrapping block. No raw HTML anywhere.
assert.match(reportBody, /const WORDS = '[^']*whitespace-pre-wrap[^']*'/, 'the report words keep their line breaks and wrap');
assert.match(reportBody, /<div className=\{WORDS\}>\{report\.description\}<\/div>/, 'the words render as plain text in that block');

// The report filters live in the Inbox's one GET form on the Reports tab: no client code, no body to sign.
const inboxFilters = fe2Source('src/components/inbox/InboxFilters.tsx');
const reportFilterFields = fe2Source('src/components/inbox/ReportFilterFields.tsx');
assert.doesNotMatch(inboxFilters + reportFilterFields, /'use client'/, 'the filters stay server components');
assert.match(inboxFilters, /method="get"/);
assert.match(inboxFilters, /action="\/inbox"/);
assert.match(inboxFilters, /<ReportFilterFields\b/, 'the Reports tab keeps the report filters (FE-2 §4.1)');
assert.match(reportFilterFields, /name="reportStatus"/, 'the report status is written as reportStatus (K2.3), never status');
assert.doesNotMatch(reportFilterFields, /name="status"/, 'the Inbox status is not redefined by the report fields');

// Actions: a plain call through adminFetchJson (it adds the payload hash) with
// the follow-up pointer; screenshots open in a new tab with no opener.
assert.match(reportPanel, /^'use client';/);
assert.match(reportPanel, /pendingActionId/, 'action loading state tracks the submitted action');
assert.match(reportPanel, /follow-up F34\b/, 'the report panel names the follow-up that revisits its manual call (F34)');
assert.match(reportPanel, /import \{ adminFetchJson \} from '@\/lib\/admin-fetch';/, 'report actions use the shared admin client (K1.3)');
assert.match(reportPanel, /adminFetchJson<ReportActionResult>\('\/api\/report-actions'/, 'actions still post to their own route');
assert.doesNotMatch(reportPanel, /(?<![A-Za-z.])fetch\(|crypto\.subtle/, 'the payload hash and the request come from adminFetchJson only');
assert.match(reportPanel, /window\.open\(result\.url, '_blank', 'noopener,noreferrer'\)/, 'screenshots open in a new tab with no opener');
assert.match(reportPanel, /rel="noopener noreferrer"/, 'the fallback link carries no opener either');
assert.doesNotMatch(reportPanel + copyButton, /localStorage|sessionStorage|indexedDB/, 'a revealed contact or a link is never stored');
assert.doesNotMatch(reportPanel + copyButton, /console\./, 'the client never logs a value');
assert.match(copyButton, /^'use client';/);
assert.match(copyButton, /navigator\.clipboard\.writeText/);

FE2_RETIRED.push(
  'src/app/(console)/reports/[id]/page.tsx',
  'src/components/ReportActionsPanel.tsx',
  'src/app/(console)/reports/page.tsx',
  'src/components/ReportFilters.tsx',
);
for (const retired of FE2_RETIRED) assert.equal(fe2Has(retired), false, `${retired} is retired`);
// --- end Reports block ---

// --- FE-2 pages and views (Tasks 12-16 append below) -----------------------------

// The Inbox page and the FE-2 views (T7).
fe2AssertRecordedPage('src/app/(console)/inbox/page.tsx', 'loadInbox(session, query)', { searchParams: true });
const fe2InboxPage = fe2Source('src/app/(console)/inbox/page.tsx');
assert.match(fe2InboxPage, /parseInboxQuery\(await searchParams\)/, 'bad query values fall back in parseInboxQuery (K2.3)');
assert.match(fe2InboxPage, /canReport\(session\.role, 'view_settings'\)/, 'the Report settings link is for superadmins, by policy');
assert.match(fe2InboxPage, /href="\/reports\/settings"/, 'report settings stay at /reports/settings (K2.5)');
// The tabs sit above the filters on every tab: beside them, the tab strip scrolled and clipped "Lockouts" at 1280.
const fe2TabsWrapper = fe2InboxPage.match(/<div className=([^>]*)>\s*<InboxTabs\b[^>]*\/>\s*<InboxFilters\b/);
assert.ok(fe2TabsWrapper, 'InboxTabs and InboxFilters share one wrapper, tabs first');
assert.doesNotMatch(fe2TabsWrapper[1], /flex-row/, 'the tabs always sit above the filters (no row layout, at any width)');
assert.match(fe2TabsWrapper[1], /flex flex-col gap-3/, 'the wrapper stacks the tabs over the filters');
assert.doesNotMatch(fe2TabsWrapper[1], /query\.tab/, 'the wrapper layout does not depend on the tab');

// Invariants over every FE-2 view file.
const FE2_UI = [...fe2Files('src/components/inbox'), ...fe2Files('src/app/(console)/inbox')];
assert.ok(FE2_UI.length >= 20, `the FE-2 scan found ${FE2_UI.length} files; expected at least 20`);
for (const path of FE2_UI) {
  const source = fe2Source(path);
  assert.doesNotMatch(source, /<img\b|next\/image/, `${path}: media and screenshots open by link, never embedded`);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/, `${path}: revealed values are never stored`);
  assert.doesNotMatch(source, /console\./, `${path}: the client never logs a value`);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `${path}: text only`);
  assert.doesNotMatch(source, /'use server'/, `${path}: mutations go through API routes, not server actions`);
  assert.doesNotMatch(source, /(?<![A-Za-z.])fetch\(|window\.fetch\(/, `${path}: requests go through adminFetchJson`);
  for (const tag of source.matchAll(/<Link\b[^>]*>/g)) {
    assert.match(tag[0], /\bprefetch=\{false\}/, `${path}: every Link is written with prefetch={false}`);
  }
  // A client island may name server types, never import server values: they
  // would pull the database and audit modules into the browser bundle.
  if (/^'use client';/.test(source)) {
    for (const line of source.match(/^import\s.+from '@\/lib\/server\/[^']+';$/gm) ?? []) {
      assert.match(line, /^import type\s/, `${path}: client code imports only types from lib/server (${line})`);
    }
  }
  // FE-1 phase 1 keeps unlayered legacy.css: an old class name would beat the utilities.
  // This scan sees literal className="…" strings only; class constants
  // (styles.ts, template strings) are on the author to keep legacy-free.
  for (const legacy of ['card', 'button', 'badge', 'pill', 'muted', 'stack', 'hero', 'panel', 'meta', 'kpi', 'num', 'list', 'row', 'field', 'visually-hidden']) {
    assert.doesNotMatch(source, new RegExp(`className="(?:[^"]*\\s)?${legacy}(?:\\s[^"]*)?"`), `${path}: no legacy class "${legacy}"`);
  }
}
assert.match(fe2Source('src/components/inbox/MediaMessage.tsx'), /window\.open\(result\.url, '_blank', 'noopener,noreferrer'\)/, 'media opens in a new tab with no opener');
const fe2Provider = fe2Source('src/components/inbox/InboxActionsProvider.tsx');
assert.match(fe2Provider, /adminFetchJson<InboxActionResult>\('\/api\/inbox-actions'/, 'K2.7 route through adminFetchJson');
assert.match(fe2Provider, /chooseRequestId\(/, 'one request id per attempt until the outcome is known');
assert.match(fe2Provider, /isUnknownOutcome\(/, 'the id is kept only after an unknown outcome');

fe2AssertRecordedPage('src/app/(console)/inbox/support/[id]/page.tsx', 'loadSupportConversation(session, id)', { params: true });
const fe2SupportPage = fe2Source('src/app/(console)/inbox/support/[id]/page.tsx');
assert.match(fe2SupportPage, /notFound\(\)/, 'an unknown case is a 404 (K2.4: null)');
assert.match(fe2SupportPage, /<InboxActionsProvider>/, 'every control on the page shares one action seam');
assert.ok(fe2Has('src/app/(console)/inbox/support/[id]/not-found.tsx'), 'the conversation has its own not-found view');
const fe2ContextPanel = fe2Source('src/components/inbox/CaseContextPanel.tsx');
assert.match(fe2ContextPanel, /accessHistoryHref\(\{ subjectUserId: worker\.userId \}\)/, 'the access history link filters by the worker user id');
assert.match(fe2ContextPanel, /role === 'admin_superadmin'/, 'the access history link is superadmin-only');
assert.match(fe2ContextPanel, /isUuid\(worker\.userId\)/, 'the access history link needs a UUID user id');
const fe2HistoryLink = fe2ContextPanel.match(/<Link\b[^>]*accessHistoryHref[^>]*>/);
assert.ok(fe2HistoryLink && /prefetch=\{false\}/.test(fe2HistoryLink[0]), 'the access history link carries prefetch={false}');
assert.match(fe2SupportPage, /role=\{session\.role\}/, 'the page hands the viewer role to the context panel');

fe2AssertRecordedPage('src/app/(console)/inbox/lockouts/[id]/page.tsx', 'loadLockoutDetail(session, id)', { params: true });
const fe2LockoutPage = fe2Source('src/app/(console)/inbox/lockouts/[id]/page.tsx');
assert.match(fe2LockoutPage, /notFound\(\)/, 'an unknown challenge is a 404');
assert.match(fe2Source('src/components/inbox/LockoutResetForm.tsx'), /import \{ LOCKOUT_RESET_REASONS, type LockoutResetReason \} from '@\/lib\/lockout-reasons';/, 'the reset reasons come from the client-safe K2.6 list');
assert.doesNotMatch(fe2LockoutPage, /LOCKOUT_RESET_REASONS/, 'the page passes no reasons; the form owns the list');
assert.match(fe2LockoutPage, /<InboxActionsProvider>/);
assert.ok(fe2Has('src/app/(console)/inbox/lockouts/[id]/not-found.tsx'));

console.log('admin UI inbox contract checks passed');
