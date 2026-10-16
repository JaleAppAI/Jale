// The Admins page (K1.5): which actions each row offers, what each answer from
// POST /api/admin-users says, and which request id a retry carries
// (src/components/admins/admin-actions.ts). The rendered forms and the view
// are checked further down.
import assert from 'node:assert/strict';
import { compileAdminSources } from './lib/check-harness.mjs';
import { IDS, admin, errorAnswer, okAnswer } from './fixtures/fe3-admins.mjs';

const { load } = compileAdminSources({
  name: 'fe3-admins-view',
  sources: ['src/components/admins/admin-actions.ts'],
});
const logic = await load('src/components/admins/admin-actions.ts');

// --- Row actions ---------------------------------------------------------------
assert.deepEqual(logic.rowActions(admin('self')), [], "the viewer's own row offers no action");
assert.deepEqual(logic.rowActions(admin('invited')), ['resend_invite'], 'an invite offers a resend only');
assert.deepEqual(logic.rowActions(admin('ops')), ['change_role', 'deactivate']);
assert.deepEqual(logic.rowActions(admin('reader')), ['change_role', 'reactivate']);
assert.deepEqual(logic.rowActions({ ...admin('ops'), isSelf: true }), [], 'self wins over every status');
assert.deepEqual(logic.ROW_ACTION_LABELS, {
  resend_invite: 'Resend invite', change_role: 'Change role', deactivate: 'Deactivate', reactivate: 'Reactivate',
});
assert.deepEqual(logic.ADMIN_STATUS_LABELS, { invited: 'Invited', active: 'Active', deactivated: 'Deactivated' });
assert.deepEqual(logic.ADMIN_STATUS_TONES, { invited: 'info', active: 'success', deactivated: 'neutral' });
assert.deepEqual(
  logic.ROLE_OPTIONS.map((option) => [option.role, option.title, option.description]),
  [
    ['admin_readonly', 'Read-only', 'Sees everything, changes nothing'],
    ['admin_ops', 'Ops', 'Works the Inbox: replies, resets, reports'],
    ['admin_superadmin', 'Superadmin', 'Also manages admins and sees Security'],
  ],
);
assert.equal(logic.DEFAULT_INVITE_ROLE, 'admin_ops', "the prototype's invite starts on Ops");

// --- Each K1.5 answer has its copy -----------------------------------------------
const COPY = {
  invalid_input: [400, 'Check the email and role.'],
  forbidden: [403, 'Only superadmins can manage admins.'],
  last_superadmin: [409, 'There must always be at least one active superadmin.'],
  self_change: [409, "You can't change your own role or deactivate yourself."],
  already_exists: [409, 'That email already has an admin account.'],
  not_invited: [409, 'This admin has already signed in, so there is no invite to resend.'],
};
for (const [error, [status, message]] of Object.entries(COPY)) {
  assert.deepEqual(
    logic.decideActionOutcome(errorAnswer(status, error)),
    { kind: 'failed', message, retry: 'new_request' },
    error,
  );
}
const SAVED = "Saved, but the sign-in directory didn't update. Try again to finish.";
const NOT_SAVED = 'Nothing changed. Try again.';
assert.deepEqual(logic.decideActionOutcome(errorAnswer(502, 'directory_sync_failed', true)), { kind: 'failed', message: SAVED, retry: 'same_request' });
assert.deepEqual(logic.decideActionOutcome(errorAnswer(502, 'directory_sync_failed', false)), { kind: 'failed', message: NOT_SAVED, retry: 'new_request' });
assert.deepEqual(logic.decideActionOutcome(errorAnswer(502, 'directory_sync_failed')), { kind: 'failed', message: NOT_SAVED, retry: 'new_request' }, 'no saved flag means not saved');
assert.deepEqual(logic.decideActionOutcome({ kind: 'redirecting' }), { kind: 'redirecting' }, 'an ended session goes to sign-in with nothing shown');
assert.deepEqual(logic.decideActionOutcome({ kind: 'network' }), { kind: 'failed', message: logic.ACTION_NETWORK_COPY, retry: 'new_request' });
assert.deepEqual(logic.decideActionOutcome({ kind: 'error', status: 504, data: null }), { kind: 'failed', message: logic.ACTION_UNCONFIRMED_COPY, retry: 'new_request' });
assert.deepEqual(logic.decideActionOutcome(errorAnswer(409, 'a_code_this_page_does_not_know')), { kind: 'failed', message: logic.ACTION_UNCONFIRMED_COPY, retry: 'new_request' });
assert.deepEqual(logic.decideActionOutcome(okAnswer(admin('ops'))), { kind: 'done', admin: admin('ops') });
assert.deepEqual(logic.decideActionOutcome({ kind: 'ok', status: 200, data: { ok: true } }), { kind: 'failed', message: logic.ACTION_UNCONFIRMED_COPY, retry: 'new_request' });
assert.equal(logic.ACTION_UNCONFIRMED_COPY, "The change couldn't be confirmed. Refresh the page to see where it stands, then try again.");
assert.equal(logic.ACTION_NETWORK_COPY, "Couldn't reach the console. Check your connection, refresh the page to see where it stands, then try again.");

// --- Request ids: only a saved change that asks for another try is resent ------
function scripted(answers) {
  const posted = [];
  let n = 0;
  const runner = logic.createAdminActionRunner({
    post: async (action) => {
      posted.push(action);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    newId: () => `request-${++n}`,
  });
  return { posted, runner };
}
const deactivate = { action: 'deactivate', adminUserId: IDS.ops };
{
  const { posted, runner } = scripted([errorAnswer(502, 'directory_sync_failed', true), okAnswer(admin('ops'))]);
  const first = await runner.run(deactivate);
  assert.deepEqual(first, { kind: 'failed', message: SAVED, retry: 'same_request' });
  const second = await runner.run(deactivate);
  assert.equal(second.kind, 'done');
  assert.equal(posted.length, 2);
  assert.equal(posted[0].requestId, 'request-1');
  assert.deepEqual(posted[1], posted[0], '"Try again" after a saved change resends the same request');
}
for (const [label, failure] of [
  ['a refusal', errorAnswer(409, 'last_superadmin')],
  ['nothing saved', errorAnswer(502, 'directory_sync_failed', false)],
  ['unreachable', { kind: 'network' }],
  ['post threw', new Error('offline')],
  ['an unreadable answer', { kind: 'error', status: 504, data: null }],
]) {
  const { posted, runner } = scripted([failure, okAnswer(admin('ops'))]);
  await runner.run(deactivate);
  await runner.run(deactivate);
  assert.notEqual(posted[0].requestId, posted[1].requestId, `${label}: the retry is a new request`);
  assert.deepEqual({ ...posted[1], requestId: '' }, { ...posted[0], requestId: '' }, `${label}: the same action otherwise`);
}
{
  const { posted, runner } = scripted([errorAnswer(502, 'directory_sync_failed', true), okAnswer(admin('reader'))]);
  await runner.run(deactivate);
  await runner.run({ action: 'reactivate', adminUserId: IDS.reader });
  assert.notEqual(posted[1].requestId, posted[0].requestId, 'another action is another request');
}
{
  const { posted, runner } = scripted([errorAnswer(502, 'directory_sync_failed', true), okAnswer(admin('ops'))]);
  await runner.run(deactivate);
  runner.reset();
  await runner.run(deactivate);
  assert.notEqual(posted[1].requestId, posted[0].requestId, 'closing the dialog forgets the saved request');
}
{
  const { posted, runner } = scripted([okAnswer(admin('ops')), okAnswer(admin('ops'))]);
  await runner.run(deactivate);
  await runner.run(deactivate);
  assert.notEqual(posted[0].requestId, posted[1].requestId, 'after success the next press is new');
}
// Review Focus 1: a second press while one is in flight posts nothing.
{
  const posted = [];
  let answer;
  const runner = logic.createAdminActionRunner({
    post: (action) => {
      posted.push(action);
      return new Promise((resolve) => { answer = resolve; });
    },
    newId: () => 'request-1',
  });
  const first = runner.run(deactivate);
  assert.deepEqual(await runner.run(deactivate), { kind: 'busy' });
  assert.equal(posted.length, 1);
  answer(okAnswer(admin('ops')));
  assert.equal((await first).kind, 'done');
}

// --- Inputs and copy ---------------------------------------------------------------
// Review Focus 4: a pasted email is trimmed; the server lower-cases it.
assert.deepEqual(
  logic.inviteInput('  New.Admin@Example.test ', 'admin_readonly'),
  { action: 'invite', email: 'New.Admin@Example.test', role: 'admin_readonly' },
);
assert.equal(logic.FOOTNOTE, "There is always at least one active superadmin. You can't deactivate or demote yourself.");
assert.equal(
  logic.INVITE_NOTE,
  'They get a Jale-branded email with a temporary password, valid for 7 days. On first sign-in they set their own password and an authenticator app.',
);
assert.deepEqual(logic.deactivateCopy('admin-b@example.test'), {
  title: 'Deactivate admin-b@example.test?',
  body: "They are signed out everywhere right away, their trusted browsers are forgotten, and they can't sign in again until a superadmin reactivates them. This is logged.",
  confirmLabel: 'Deactivate',
});
assert.deepEqual(logic.reactivateCopy('admin-c@example.test'), {
  title: 'Reactivate admin-c@example.test?',
  body: 'They can sign in again with their password and authenticator app. They start with no trusted browsers. This is logged.',
  confirmLabel: 'Reactivate',
});
assert.equal(logic.changeRoleTitle('admin-b@example.test'), 'Change role for admin-b@example.test');
const ops = admin('ops');
assert.equal(logic.successMessage({ action: 'invite', email: ops.email, role: 'admin_ops' }, ops), 'Invite sent to admin-b@example.test.');
assert.equal(logic.successMessage({ action: 'resend_invite', adminUserId: ops.id }, ops), 'Invite sent again to admin-b@example.test.');
assert.equal(logic.successMessage({ action: 'change_role', adminUserId: ops.id, role: 'admin_ops' }, ops), 'admin-b@example.test is now Ops.');
assert.equal(logic.successMessage({ action: 'deactivate', adminUserId: ops.id }, ops), 'admin-b@example.test is deactivated.');
assert.equal(logic.successMessage({ action: 'reactivate', adminUserId: ops.id }, ops), 'admin-b@example.test can sign in again.');

// --- The forms (rendered) ----------------------------------------------------------
// Dialogs render nothing on the server (the Modal waits for a DOM), so the
// forms inside them are rendered directly.
{
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { load: loadForms } = compileAdminSources({
    name: 'fe3-admins-forms',
    sources: [
      'src/components/admins/RoleCards.tsx',
      'src/components/admins/InviteForm.tsx',
      'src/components/admins/ChangeRoleForm.tsx',
    ],
    // In case a design-system primitive links or routes.
    fakes: {
      'next/link': 'scripts/fakes/next-link.mjs',
      'next/navigation': 'scripts/fakes/next-navigation.mjs',
    },
  });
  const { RoleCards } = await loadForms('src/components/admins/RoleCards.tsx');
  const { InviteForm } = await loadForms('src/components/admins/InviteForm.tsx');
  const { ChangeRoleForm } = await loadForms('src/components/admins/ChangeRoleForm.tsx');
  const noop = () => {};
  const count = (html, pattern) => (html.match(pattern) ?? []).length;
  const radio = (value, checked) => new RegExp(
    `<input(?=[^>]*type="radio")(?=[^>]*value="${value}")${checked ? '(?=[^>]*checked="")' : '(?![^>]*checked)'}[^>]*>`,
  );

  // Role cards: one radio group, the prototype's copy, the chosen one checked.
  {
    const html = renderToStaticMarkup(createElement(RoleCards, { name: 'invite-role', value: 'admin_ops', onChange: noop }));
    assert.match(html, /<fieldset/);
    assert.match(html, /<legend[^>]*>Role<\/legend>/);
    assert.equal(count(html, /type="radio"/g), 3);
    assert.equal(count(html, /name="invite-role"/g), 3);
    assert.match(html, radio('admin_ops', true));
    assert.match(html, radio('admin_readonly', false));
    assert.match(html, radio('admin_superadmin', false));
    for (const text of ['Read-only', 'Sees everything, changes nothing', 'Ops', 'Works the Inbox: replies, resets, reports', 'Superadmin', 'Also manages admins and sees Security']) {
      assert.match(html, new RegExp(`>${text}<`));
    }
  }
  const invite = (extra = {}) => renderToStaticMarkup(createElement(InviteForm, {
    email: '', role: 'admin_ops', busy: false,
    onEmailChange: noop, onRoleChange: noop, onSubmit: noop, onCancel: noop, ...extra,
  }));
  // The invite form as the prototype draws it.
  {
    const html = invite();
    assert.match(html, /<label[^>]*for="invite-email"[^>]*>Work email<\/label>/);
    // React keeps spellCheck camelCase in markup: match attribute names case-insensitively.
    assert.match(html, /<input(?=[^>]*id="invite-email")(?=[^>]*type="email")(?=[^>]*required="")(?=[^>]*placeholder="name@company\.com")(?=[^>]*spellcheck="false")[^>]*>/i);
    assert.match(html, /They get a Jale-branded email with a temporary password, valid for 7 days\. On first sign-in they set their own password and an authenticator app\./);
    assert.equal(count(html, /<button/g), 2);
    assert.match(html, /<button(?=[^>]*type="submit")[^>]*>[\s\S]*?Send invite/);
    assert.match(html, /<button(?=[^>]*type="button")[^>]*>[\s\S]*?Cancel/);
    assert.doesNotMatch(html, /role="alert"/);
    assert.doesNotMatch(html, /<input(?=[^>]*id="invite-email")(?=[^>]*\sdisabled="")[^>]*>/);
  }
  // A refused invite: the message, and the same form to fix it.
  {
    const html = invite({ email: 'admin-b@example.test', feedback: { message: 'That email already has an admin account.', retry: 'new_request' } });
    assert.match(html, /role="alert"[\s\S]*?That email already has an admin account\./);
    assert.match(html, /Send invite/);
    assert.doesNotMatch(html, /Try again/);
    assert.doesNotMatch(html, /<input(?=[^>]*id="invite-email")(?=[^>]*\sdisabled="")[^>]*>/);
  }
  // Saved but not synced: "Try again" resends the same invite, so nothing can be edited.
  {
    const html = invite({ email: 'admin-e@example.test', feedback: { message: "Saved, but the sign-in directory didn't update. Try again to finish.", retry: 'same_request' } });
    assert.match(html, /Saved, but the sign-in directory didn&#x27;t update\. Try again to finish\./);
    assert.match(html, /<button(?=[^>]*type="submit")[^>]*>[\s\S]*?Try again/);
    assert.match(html, /<input(?=[^>]*id="invite-email")(?=[^>]*disabled="")[^>]*>/);
    assert.match(html, /<fieldset[^>]*disabled=""/);
  }
  // Change role: nothing to save until another role is picked.
  {
    const same = renderToStaticMarkup(createElement(ChangeRoleForm, {
      currentRole: 'admin_ops', role: 'admin_ops', busy: false,
      onRoleChange: noop, onSubmit: noop, onCancel: noop,
    }));
    assert.match(same, /<button(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>[\s\S]*?Save role/);
    assert.match(same, /The new role applies from their next page load\. This is logged\./);
    const other = renderToStaticMarkup(createElement(ChangeRoleForm, {
      currentRole: 'admin_ops', role: 'admin_readonly', busy: false,
      onRoleChange: noop, onSubmit: noop, onCancel: noop,
    }));
    assert.match(other, /<button(?=[^>]*type="submit")(?![^>]*\sdisabled="")[^>]*>[\s\S]*?Save role/);
    assert.match(other, radio('admin_readonly', true));
  }
}

// --- The view (rendered) ------------------------------------------------------------
{
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { adminRoot } = await import('./lib/check-harness.mjs');
  const { ADMINS, FORBIDDEN_RESULT, NOW_ISO, OK_RESULT } = await import('./fixtures/fe3-admins.mjs');
  const { load: loadView } = compileAdminSources({
    name: 'fe3-admins-render',
    // Every module the check loads is listed, so the red run (a stub view
    // that imports nothing) still compiles them.
    sources: [
      'src/components/admins/AdminsView.tsx',
      'src/components/admins/admin-actions.ts',
      'src/components/ui/toast.tsx',
      'src/components/shell/role-label.ts',
      'src/lib/local-time.ts',
    ],
    fakes: {
      'next/link': 'scripts/fakes/next-link.mjs',
      'next/navigation': 'scripts/fakes/next-navigation.mjs',
    },
  });
  const { AdminsView } = await loadView('src/components/admins/AdminsView.tsx');
  const { ToastProvider } = await loadView('src/components/ui/toast.tsx');
  const { roleLabel } = await loadView('src/components/shell/role-label.ts');
  const localTime = await loadView('src/lib/local-time.ts');
  const viewLogic = await loadView('src/components/admins/admin-actions.ts');
  // useToast throws outside its provider, as the console layout mounts it.
  const render = (result) => renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(AdminsView, { result, nowIso: NOW_ISO })),
  );
  const count = (html, pattern) => (html.match(pattern) ?? []).length;
  const rowOf = (html, id) => html.match(new RegExp(`<tr[^>]*data-admin="${id}"[^>]*>([\\s\\S]*?)</tr>`))?.[1] ?? '';

  // The 403 state.
  {
    const html = render(FORBIDDEN_RESULT);
    assert.match(html, /<h1[^>]*>Admins is for superadmins<\/h1>/);
    assert.match(html, /Only superadmins can manage admins\./);
    assert.match(html, /<a[^>]*href="\/"[^>]*>Back to Home<\/a>/);
    assert.doesNotMatch(html, /<table|Invite admin/);
  }
  // The list.
  {
    const html = render(OK_RESULT);
    assert.match(html, /<h1[^>]*>Admins<\/h1>/);
    assert.match(html, /Who can sign in to this console, and what they can do\. Every change here is logged\./);
    assert.match(html, /<button[^>]*>[\s\S]*?Invite admin/);
    assert.deepEqual(
      [...html.matchAll(/<th[^>]*scope="col"[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]),
      ['Admin', 'Role', 'Status', 'Last sign-in', 'Trusted browsers', 'Actions'],
    );
    assert.match(html, /<div(?=[^>]*role="region")(?=[^>]*tabindex="0")[^>]*>/, 'the table scrolls inside its own region');
    assert.equal(count(html, /<tr[^>]*data-admin="/g), ADMINS.length);
    for (const item of ADMINS) {
      const row = rowOf(html, item.id);
      assert.match(row, new RegExp(`translate="no"[^>]*>${item.email.replace(/[.]/g, '\\.')}<`), `${item.email}: the email is the identity`);
      assert.match(row, new RegExp(`>${roleLabel(item.role)}<`));
      assert.match(row, new RegExp(`>${viewLogic.ADMIN_STATUS_LABELS[item.status]}<`));
      assert.match(row, new RegExp(`>${item.trustedBrowsers}<`));
      if (item.lastSignInAt) {
        // Attribute names are matched case-insensitively, as check-access-history-view.mjs does for <time>.
        assert.match(row, new RegExp(`<time[^>]*datetime="${item.lastSignInAt}"[^>]*>${localTime.relativeText(item.lastSignInAt, Date.parse(NOW_ISO))}<`, 'i'));
      } else {
        assert.match(row, />Never</);
      }
    }
    const self = rowOf(html, IDS.self);
    assert.match(self, /This is you/);
    assert.equal(count(self, /<button/g), 0, "the viewer's row has no actions");
    const invited = rowOf(html, IDS.invited);
    assert.equal(count(invited, /<button/g), 1);
    assert.match(invited, /Resend invite/);
    assert.doesNotMatch(invited, /Change role|Deactivate/);
    const ops = rowOf(html, IDS.ops);
    assert.equal(count(ops, /<button/g), 2);
    assert.match(ops, /Change role/);
    assert.match(ops, /Deactivate/);
    assert.match(ops, /<span class="sr-only"> for admin-b@example\.test<\/span>/, 'each action names its admin to a screen reader');
    const reader = rowOf(html, IDS.reader);
    assert.equal(count(reader, /<button/g), 2);
    assert.match(reader, /Reactivate/);
    assert.doesNotMatch(reader, />Deactivate</);
    assert.match(html, /There is always at least one active superadmin\. You can&#x27;t deactivate or demote yourself\./);
  }
  // An empty list still renders the page.
  assert.match(render({ status: 'ok', viewerId: IDS.self, admins: [] }), /No admins to show\./);
  // The role cards and the shell agree on role names.
  for (const option of viewLogic.ROLE_OPTIONS) assert.equal(option.title, roleLabel(option.role));

  // Mutations go through admin-fetch; an ended session shows nothing new (Review Focus 2).
  const hook = readFileSync(resolve(adminRoot, 'src/components/admins/use-admin-action.ts'), 'utf8');
  assert.match(hook, /adminFetchJson<AdminUserActionResult>\('\/api\/admin-users'/);
  assert.match(hook, /createAdminActionRunner\(/);
  assert.match(hook, /crypto\.randomUUID\(\)/);
  assert.match(hook, /result\.kind === 'redirecting'\) return false;[\s\S]*setBusy\(false\)/, 'busy stays on while the browser leaves');
  assert.match(hook, /router\.refresh\(\)/);
  for (const file of ['AdminsView.tsx', 'AdminsTable.tsx', 'InviteDialog.tsx', 'ChangeRoleDialog.tsx', 'DeactivateDialog.tsx', 'ReactivateDialog.tsx', 'ResendInviteButton.tsx', 'use-admin-action.ts']) {
    const source = readFileSync(resolve(adminRoot, 'src/components/admins', file), 'utf8');
    assert.doesNotMatch(source, /\bfetch\(/, `${file}: no hand-rolled fetch`);
    assert.doesNotMatch(source, /from '@\/lib\/server\/(?!admin-users')|import \{[^}]*\} from '@\/lib\/server\/admin-users'/, `${file}: types only from the server`);
  }
}

// --- A lost invite answer: already_exists also refreshes the list ----------------
{
  const exists = logic.decideActionOutcome(errorAnswer(409, 'already_exists'));
  assert.equal(logic.refreshesListAfter(exists), true, 'already_exists reloads the list');
  assert.equal(exists.message, 'That email already has an admin account.', 'the copy stays');
  for (const decision of [
    logic.decideActionOutcome(errorAnswer(409, 'last_superadmin')),
    logic.decideActionOutcome(errorAnswer(403, 'forbidden')),
    logic.decideActionOutcome(errorAnswer(502, 'directory_sync_failed', true)),
    logic.decideActionOutcome({ kind: 'network' }),
    logic.decideActionOutcome({ kind: 'redirecting' }),
    logic.decideActionOutcome(okAnswer(admin('ops'))),
  ]) assert.equal(logic.refreshesListAfter(decision), false, JSON.stringify(decision));
  const hookSource = (await import('node:fs')).readFileSync(new URL('../src/components/admins/use-admin-action.ts', import.meta.url), 'utf8');
  assert.match(hookSource, /refreshesListAfter\(result\)\) router\.refresh\(\)/, 'the hook refreshes on already_exists');
}

console.log('admin Admins view checks passed');
