// Admin UI contract: sign-in, the Admins page and the Security page (FE-3).
// Source-text checks on AdminLoginForm, /admins, /security and their
// components, and on the /audit stub while it exists. The rendered behaviour
// is in check-ui-login-form.mjs, check-ui-admins-view.mjs,
// check-ui-security-view.mjs and check-access-history-view.mjs.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { read, root } from './lib/ui-contract-helpers.mjs';

const exists = (path) => existsSync(resolve(root, path));

// --- Sign-in --------------------------------------------------------------------
const login = read('src/components/AdminLoginForm.tsx');
assert.match(
  login,
  />Back to sign in</,
  'every step after the first keeps its way back to the start (check-ui-login-form.mjs renders each one)',
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

// --- /audit -----------------------------------------------------------------------
// /audit read admin_audit_log directly. While its stub page exists it must
// redirect to the access history and read nothing. FE-1 replaces the stub
// with a redirect in next.config.mjs, which check-ui-redirects.mjs pins.
if (exists('src/app/(console)/audit/page.tsx')) {
  const auditPage = read('src/app/(console)/audit/page.tsx');
  assert.match(auditPage, /redirect\('\/(?:access-history|security)'\)/, '/audit must redirect to the access history');
  assert.doesNotMatch(auditPage, /listAuditEvents|admin_audit_log|getAdminDbPool/, '/audit must not read the action log any more');
}

// --- Security: the access history and sign-ins (K1.6) ------------------------------
assert.equal(exists('src/app/(console)/security/page.tsx'), true, '/security exists');
assert.equal(exists('src/app/(console)/access-history/page.tsx'), false, 'the old page is gone; /access-history redirects to /security');
assert.equal(exists('src/components/access-history'), false, 'the access history components live under components/security');
const securityPage = read('src/app/(console)/security/page.tsx');
assert.match(securityPage, /const session = await requireAdminSession\(\)/, 'Security gates on an admin session');
assert.match(securityPage, /searchParams:\s*Promise</, 'Security types searchParams as a Promise (Next 16)');
assert.match(securityPage, /loadAccessHistory\(session, await searchParams\)/, 'Security loads through the access-history loader');
assert.match(securityPage, /loadAdmins\(session\)/, 'the Admin filter lists admins through their recorded loader');
assert.match(securityPage, /result\.status === 'ok' \|\| result\.status === 'invalid'/, 'a refused or preview page reads no admin list');
assert.doesNotMatch(securityPage, /getAdminDbPool|@\/lib\/server\/db['"]|\.query\(|SELECT /, 'Security never reads the database itself');
const historyView = read('src/components/security/AccessHistoryView.tsx');
const historyFilters = read('src/components/security/AccessHistoryFilters.tsx');
// Nothing on the page can change an entry: no action panel, no POST form,
// no server action, no fetch.
for (const [label, source] of [
  ['src/app/(console)/security/page.tsx', securityPage],
  ['AccessHistoryView.tsx', historyView],
  ['AccessHistoryFilters.tsx', historyFilters],
]) {
  assert.doesNotMatch(
    source,
    /AdminActionsPanel|method=["']post["']|@\/app\/actions|'use server'|fetch\(/i,
    `${label}: the access history has no edit controls`,
  );
}
assert.match(historyFilters, /^'use client';/, 'the search form is the only client island with state');
assert.match(historyFilters, /role="search"/, 'the filters are a search landmark');
assert.doesNotMatch(historyView, /'use client'/, 'the entries render on the server');
assert.doesNotMatch(historyView + historyFilters, /<main\b/, 'the console layout owns the main landmark');
// Every search is recorded, so its links never prefetching matters here most:
// a prefetch would run a search the admin did not make, one per link on a page
// of ids. The app-wide link rule in check-ui-shell.mjs pins it.

// --- Admins (K1.5) -------------------------------------------------------------------
assert.equal(exists('src/app/(console)/admins/page.tsx'), true, '/admins exists');
const adminsPage = read('src/app/(console)/admins/page.tsx');
assert.match(adminsPage, /const session = await requireAdminSession\(\)/, 'Admins gates on an admin session');
assert.match(adminsPage, /loadAdmins\(session\)/, 'Admins lists through its recorded loader');
assert.doesNotMatch(adminsPage, /getAdminDbPool|@\/lib\/server\/db['"]|\.query\(|SELECT /, 'Admins never reads the database itself');
assert.doesNotMatch(adminsPage, /'use client'/, 'the page stays a server component');
assert.match(read('src/components/admins/AdminsView.tsx'), /^'use client';/);

console.log('admin UI access contract checks passed');
