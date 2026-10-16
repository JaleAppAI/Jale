// Renders the FE-2 Inbox views with react-dom/server against K2-shaped
// fixtures (scripts/fixtures/fe2-*.mjs) and checks their pure view helpers.
// test:ui runs it. Each section names the plan task that added it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adminRoot, compileAdminSources } from './lib/check-harness.mjs';
import * as inboxFx from './fixtures/fe2-inbox.mjs';
import * as convFx from './fixtures/fe2-conversation.mjs';
import * as lockFx from './fixtures/fe2-lockout.mjs';

// Server-rendered times are UTC text; a fixed zone keeps them exact.
process.env.TZ = 'UTC';

// Every source a section loads. A task that adds a section adds its files.
const SOURCES = [
  'src/lib/support-reply.ts',
  'src/components/inbox/inbox-view.ts',
  'src/components/inbox/inbox-actions-context.ts',
  'src/components/inbox/InboxTabs.tsx',
  'src/components/inbox/InboxFilters.tsx',
  'src/components/inbox/ReportFilterFields.tsx',
  'src/components/inbox/DisabledReasons.tsx',
  'src/components/inbox/TemplatePreview.tsx',
  'src/components/inbox/ReplyComposer.tsx',
  'src/components/inbox/WindowBanner.tsx',
  'src/components/inbox/ThreadScroller.tsx',
  'src/components/inbox/ConversationThread.tsx',
  'src/components/inbox/MessageBubble.tsx',
  'src/components/inbox/MediaMessage.tsx',
  'src/components/inbox/RevealPhoneDialog.tsx',
  'src/components/inbox/LockoutResetForm.tsx',
  'src/components/inbox/OpenSupportButton.tsx',
  'src/components/inbox/LockoutTimeline.tsx',
  'src/lib/lockout-reasons.ts',
  'src/components/inbox/inbox-run-result.ts',
  'src/components/inbox/WindowCountdown.tsx',
  'src/components/inbox/InboxActionsProvider.tsx',
  'src/lib/local-time.ts',
  'src/components/inbox/InboxTable.tsx',
  'src/components/inbox/CaseContextPanel.tsx',
  'src/components/inbox/LockoutStats.tsx',
];

const { load } = compileAdminSources({
  name: 'inbox-view',
  sources: SOURCES,
  fakes: {
    'next/link': 'scripts/fixtures/fe2-next-link.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
  },
});

// --- Markup helpers -----------------------------------------------------------
const render = (element) => renderToStaticMarkup(element);
const decode = (text) => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
/** The visible text of some markup: tags dropped, whitespace collapsed. */
const textOf = (markup) => decode(markup.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const readSource = (path) => readFileSync(resolve(adminRoot, path), 'utf8');
function buttons(markup) {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map(([, attrs, inner]) => ({ attrs, text: textOf(inner) }));
}
/** The one button whose text includes `name` (FE-1's Button repeats its label for the loading state). */
function button(markup, name) {
  const found = buttons(markup).filter((candidate) => candidate.text.includes(name));
  assert.equal(found.length, 1, `exactly one button reads "${name}" (found ${found.length})`);
  return found[0];
}
const isDisabled = (found) => /(^|\s)disabled=""/.test(found.attrs);
function anchors(markup) {
  return [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => ({
    attrs,
    inner,
    text: textOf(inner),
    href: decode(/(?:^|\s)href="([^"]*)"/.exec(attrs)?.[1] ?? ''),
  }));
}
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// --- Task 1: Inbox list helpers ----------------------------------------------
const view = await load('src/components/inbox/inbox-view.ts');

assert.deepEqual(view.INBOX_TABS.map((tab) => [tab.id, tab.label]), [
  ['all', 'All'], ['support', 'Support'], ['reports', 'Problem reports'], ['lockouts', 'Lockouts'],
], 'the four tabs, in the prototype order');
assert.deepEqual(view.INBOX_STATUS_OPTIONS.map((option) => [option.id, option.label]), [
  ['waiting', 'Open + waiting'], ['waiting_on_worker', 'Waiting on worker'], ['resolved', 'Resolved'], ['all', 'All'],
], 'the status filter options (FE-2 §4.1)');

assert.equal(view.inboxListHref({ tab: 'all', status: 'waiting' }), '/inbox', 'defaults stay out of the URL');
assert.equal(
  view.inboxListHref({ tab: 'reports', status: 'resolved', q: ' R-88 ', before: 'c2FtcGxl' }),
  '/inbox?tab=reports&status=resolved&q=R-88&before=c2FtcGxl',
  'tab, status, a trimmed search and the cursor are kept',
);
assert.equal(view.inboxListHref({ tab: 'support', status: 'waiting', q: '   ' }), '/inbox?tab=support', 'an empty search is dropped');

const DETAIL_PREFIX = {
  support: '/inbox/support/', delivery_issue: '/inbox/support/', stuck_conversation: '/inbox/support/',
  verification_blocker: '/inbox/support/', report: '/inbox/reports/', lockout: '/inbox/lockouts/',
};
for (const item of inboxFx.INBOX_ITEMS) {
  assert.equal(view.inboxDetailHref(item.kind, item.id), item.href, `${item.kind} opens its own view (K2.3)`);
  assert.ok(item.href.startsWith(DETAIL_PREFIX[item.kind]), `${item.kind} fixture follows K2.3`);
}
assert.equal(view.inboxDetailHref('support', 'a/b?c'), '/inbox/support/a%2Fb%3Fc', 'an id is always one path segment');
assert.equal(view.supportCaseHref(inboxFx.fid(0xc1)), `/inbox/support/${inboxFx.fid(0xc1)}`);

assert.equal(view.waitingTone('us'), 'warning');
assert.equal(view.waitingTone('worker'), 'info');
assert.equal(view.waitingTone('nobody'), 'neutral');

assert.equal(view.inboxFooterText(6, 9), 'Showing 6 of 9 · unread items are marked with a blue dot');

assert.deepEqual(view.inboxEmptyCopy({ tab: 'lockouts', status: 'waiting' }), {
  title: 'No one is locked out of verification',
  body: 'Workers locked out of identity verification on WhatsApp show up here.',
  filtered: false,
});
assert.equal(view.inboxEmptyCopy({ tab: 'all', status: 'waiting' }).title, 'Nothing is waiting on an admin');
assert.equal(view.inboxEmptyCopy({ tab: 'support', status: 'waiting' }).title, 'No support conversations are waiting');
assert.equal(view.inboxEmptyCopy({ tab: 'reports', status: 'waiting' }).title, 'No problem reports are waiting');
assert.deepEqual(view.inboxEmptyCopy({ tab: 'all', status: 'resolved' }), {
  title: 'Nothing matches these filters', body: 'Try another status, or clear the search.', filtered: true,
});
assert.equal(view.inboxEmptyCopy({ tab: 'all', status: 'waiting', q: 'S-1' }).filtered, true, 'a search narrows the list');

// --- Task 2: conversation and reply-box helpers ------------------------------
assert.equal(view.templateLine('Hola\nqué\r\ntal'), 'Hola qué tal', 'each line break becomes one space');
assert.equal(view.replyLength('a\nb', 'template'), 3);
assert.equal(view.replyLength('a\nb', 'freeform'), 3, 'a textarea value uses \\n, so both counts agree');
// --- B2: the template count is BE-2b's shared support reply rule (CCR-7) ---
const shared = await load('src/lib/support-reply.ts');
for (const input of ['a\tb', 'a\r\nb', '  lead and trail  ', 'a \t\r\n\n b', '', '   ', 'caf\u00e9 \u{1F600} ok', '\u{1F600}'.repeat(3), '\u00a0nbsp\u00a0\u00a0x\u00a0']) {
  assert.equal(view.replyLength(input, 'template'), shared.templateReplyLength(input), `template length of ${JSON.stringify(input)} is BE-2b's`);
  assert.equal(view.templateLine(input), shared.templateReplyText(input), `template text of ${JSON.stringify(input)} is BE-2b's`);
}
assert.equal(view.replyLength('\u{1F600}', 'template'), 2, 'a non-BMP emoji counts as two UTF-16 code units');
assert.equal(view.replyLength('a\tb', 'template'), 3, 'a tab run is one space');
assert.equal(view.replyLength('  a\tb \r\n', 'freeform'), 8, 'freeform stays the raw length');
assert.equal(shared.TEMPLATE_REPLY_MAX_CHARS, 250);
assert.equal(
  view.inboxActionMessage('reply', { ok: false, error: 'reply_too_long_for_template' }).text,
  `The chat window is about to close or has closed, so replies are limited to ${shared.TEMPLATE_REPLY_MAX_CHARS} characters. Shorten it and send again.`,
  'the missing-maxChars fallback is the shared template max',
);
// --- Task 5a: the template count is the server's (whitespace collapsed, trimmed) ---
assert.equal(view.replyLength('a  b\n\n c ', 'template'), 5, 'every whitespace run is one space and the ends are trimmed');
assert.equal(view.templateLine('  a \t\t b\r\n\r\nc  '), 'a b c', 'templateLine collapses and trims');
assert.equal(view.replyLength('a  b\n\n c ', 'freeform'), 9, 'freeform counts the raw text');
assert.deepEqual(view.replyCount('', 'template', 250), { used: 0, max: 250, over: false, label: '0 / 250' });
assert.deepEqual(view.replyCount('x'.repeat(251), 'template', 250), { used: 251, max: 250, over: true, label: '251 / 250' });
assert.equal(view.replyCount('', 'freeform', 1000).label, '0 / 1000');
assert.equal(view.replyProblem('   ', 'freeform', 1000), 'Write a reply first.');
assert.equal(view.replyProblem('x'.repeat(251), 'template', 250), 'Shorten to 250 characters.');
assert.equal(view.replyProblem('x'.repeat(251), 'freeform', 1000), null);
assert.equal(view.replyProblem('Hola', 'template', 250), null);

assert.deepEqual(view.templatePreviewParts(convFx.TEMPLATE_ES, ''), { before: 'Jale Soporte: «', reply: null, after: '». Responde a este mensaje si necesitas más ayuda.' });
assert.deepEqual(view.templatePreviewParts(convFx.TEMPLATE_EN, ' Try\nagain '), { before: 'Jale Support replied to your help request: “', reply: 'Try again', after: '”. Reply to this message if you need more help.' });
assert.equal(view.TEMPLATE_NEWLINE_NOTE, 'Line breaks become spaces.');
assert.equal(view.sendLabel('freeform'), 'Send reply');
assert.equal(view.sendLabel('template'), 'Send in template');
assert.equal(view.replyPlaceholder('es'), 'Escribe tu respuesta…');
assert.equal(view.replyPlaceholder('en'), 'Write your reply…');

assert.equal(view.adminByline('Ops'), 'Ops admin');
assert.equal(view.adminByline('Read-only'), 'Read-only admin');
assert.equal(view.adminByline('Superadmin'), 'Superadmin');
assert.equal(view.deliveryText({ delivery: 'waiting_for_window', via: null }), 'Waiting for the worker to reply');
assert.equal(view.deliveryText({ delivery: 'sent', via: 'template' }), 'Sent · sent in template');
assert.equal(view.deliveryText({ delivery: 'failed', via: 'freeform' }), 'Not delivered');
assert.deepEqual(['image', 'audio', 'document'].map(view.mediaLabel), ['Photo', 'Voice note', 'Document']);

assert.equal(view.hasWorkerMessages(convFx.OPEN_CONVERSATION.messages), true);
assert.equal(view.hasWorkerMessages(convFx.FROM_LOCKOUT_CONVERSATION.messages), false);
assert.equal(view.hasWorkerMessages([]), false);
assert.equal(view.conversationSubtitle(convFx.OPEN_CONVERSATION), 'Support conversation on WhatsApp · Worker #1042 · Spanish');
assert.equal(
  view.conversationSubtitle({ ...convFx.OPEN_CONVERSATION, kind: 'delivery_issue', typeLabel: 'Delivery issue' }),
  'Delivery issue case on WhatsApp · Worker #1042 · Spanish',
);
assert.deepEqual(
  ['open', 'pending_admin', 'pending_worker', 'resolved', 'dismissed'].map(view.caseStatusTone),
  ['warning', 'warning', 'info', 'success', 'neutral'],
);

assert.equal(view.onboardingText(convFx.OPEN_CONVERSATION.worker), 'Identity check (step 5 of 8)');
assert.equal(view.onboardingText({ onboardingStepLabel: 'Trade', onboardingStepIndex: null, onboardingStepCount: 8 }), 'Trade');
assert.equal(view.onboardingText(convFx.FROM_LOCKOUT_CONVERSATION.worker), '—', 'null never prints');
assert.equal(view.failedCodesText(2), '2 failed codes today');
assert.equal(view.failedCodesText(1), '1 failed code today');
assert.equal(view.contentText(3, 2), '3 messages · 2 attachments');
assert.equal(view.contentText(1, 1), '1 message · 1 attachment');
assert.equal(view.contentText(0, 0), '0 messages');
assert.equal(view.adminsToldText(2), '2, by email');
assert.equal(view.adminsToldText(0), 'No one yet');
assert.equal(
  view.windowClosedRest('Spanish'),
  'WhatsApp now only accepts the approved support-reply template, so your text goes inside it, in Spanish. When the worker answers, the chat reopens in support mode.',
);

// --- Task 3: action, reveal and lockout helpers -------------------------------
assert.deepEqual(
  view.withRequestId({ action: 'reply', caseId: convFx.CASE_OPEN, text: 'Hola' }, inboxFx.fid(0x1)),
  { action: 'reply', caseId: convFx.CASE_OPEN, text: 'Hola', requestId: inboxFx.fid(0x1) },
);
assert.deepEqual([...view.INBOX_ACTION_ERRORS].sort(), [
  'case_closed', 'forbidden', 'invalid_input', 'media_expired', 'no_reply_target', 'not_found', 'not_locked',
  'reply_too_long_for_template', 'session_expired', 'unauthorized',
], 'exactly the K2.7 errors');

// Only K2.7-shaped answers count; media links must be https.
for (const good of [
  { ok: true, kind: 'done' },
  { ok: true, kind: 'media', url: 'https://bucket.example.test/x', expiresAt: '2026-10-14T15:05:00.000Z' },
  { ok: true, kind: 'phone', phone: '+0 000 000 0000' },
  { ok: true, kind: 'case', caseId: convFx.CASE_OPEN },
  { ok: false, error: 'case_closed' },
  { ok: false, error: 'reply_too_long_for_template', maxChars: 250 },
]) {
  assert.equal(view.isInboxActionResult(good), true, JSON.stringify(good));
}
for (const bad of [
  null, 'ok', { error: 'not_implemented' }, { ok: false, error: 'not_implemented' },
  { ok: true, kind: 'media', url: 'javascript:alert(1)', expiresAt: 'x' }, { ok: true, kind: 'media', url: 'http://x.test', expiresAt: 'x' },
  { ok: true, kind: 'phone' }, { ok: true, kind: 'other' }, { ok: false, error: 'case_closed', maxChars: -1 },
]) {
  assert.equal(view.isInboxActionResult(bad), false, JSON.stringify(bad));
}

// K2.7 error -> what the admin reads (FE-2 §4.2 and the plan's Copy table).
const message = (action, result) => view.inboxActionMessage(action, result);
assert.deepEqual(message('reply', { ok: false, error: 'reply_too_long_for_template', maxChars: 250 }), { tone: 'danger', text: 'The chat window is about to close or has closed, so replies are limited to 250 characters. Shorten it and send again.' });
assert.equal(message('reply', { ok: false, error: 'reply_too_long_for_template' }).text, 'The chat window is about to close or has closed, so replies are limited to 250 characters. Shorten it and send again.', 'a missing maxChars falls back to the template cap');
assert.equal(message('reply', { ok: false, error: 'case_closed' }).text, 'This case is closed, so nothing was sent. The page now shows its latest state.');
assert.equal(message('open_media', { ok: false, error: 'media_expired' }).text, 'This file was removed after 90 days.');
assert.equal(message('reset_lockout', { ok: false, error: 'not_locked' }).text, 'This verification is no longer locked, so there is nothing to reset. The page now shows its latest state.');
assert.equal(message('reply', { ok: false, error: 'no_reply_target' }).text, 'This case has no WhatsApp number to reply to.');
assert.equal(message('resolve', { ok: false, error: 'forbidden' }).text, 'Requires Ops or Superadmin.');
assert.equal(message('reply', { ok: false, error: 'not_found' }).text, 'This item no longer exists. Go back to the Inbox.');
assert.equal(message('reveal_phone', { ok: false, error: 'invalid_input' }).text, 'Give a reason of 20 to 500 characters.');
assert.equal(message('reply', { ok: false, error: 'network' }).text, 'No answer from the server. Check your connection and try again: the same request is never sent twice.');
assert.equal(message('reply', { ok: false, error: 'unexpected', status: 501 }).text, 'Something went wrong. Reload the page and try again.');
assert.equal(message('reply', { ok: false, error: 'redirecting' }), null, '401: adminFetchJson is leaving for sign-in, so render nothing new');
assert.equal(message('reply', { ok: false, error: 'busy' }), null);
assert.deepEqual(message('reply', { ok: true, kind: 'done' }), { tone: 'success', text: 'Reply queued.' });
assert.equal(message('request_info', { ok: true, kind: 'done' }).text, 'Request for more info queued.');
assert.equal(message('resolve', { ok: true, kind: 'done' }).text, 'Case resolved. The closing message is queued.');
assert.equal(message('reset_lockout', { ok: true, kind: 'done' }).text, 'Verification reset. The worker is told on WhatsApp.');
assert.equal(message('open_media', { ok: true, kind: 'media', url: 'https://x.test', expiresAt: 'x' }), null);

assert.equal(view.shouldRefresh({ ok: true, kind: 'done' }), true);
assert.equal(view.shouldRefresh({ ok: false, error: 'reply_too_long_for_template', maxChars: 250 }), true, 'the refresh brings the template preview');
for (const error of ['case_closed', 'not_locked', 'forbidden']) assert.equal(view.shouldRefresh({ ok: false, error }), true, error);
for (const error of ['network', 'redirecting', 'busy', 'media_expired', 'not_found', 'invalid_input']) assert.equal(view.shouldRefresh({ ok: false, error, status: 0 }), false, error);
assert.equal(view.shouldRefresh({ ok: true, kind: 'phone', phone: 'x' }), false, 'a refresh would not drop the revealed phone, but nothing changed');

// Actions: disabled with a reason, never hidden.
assert.deepEqual(view.caseAction(convFx.OPS_ACTIONS, 'resolve'), { id: 'resolve', enabled: true });
assert.deepEqual(view.caseAction([], 'resolve'), { id: 'resolve', enabled: false, reason: 'Not available for this case.' });
assert.deepEqual(view.disabledReasons(convFx.READONLY_ACTIONS), ['Requires Ops or Superadmin.'], 'one line per distinct reason');
assert.deepEqual(view.disabledReasons([{ id: 'reply', enabled: false }, { id: 'resolve', enabled: true }]), ['Not available right now.']);
assert.deepEqual(view.disabledReasons(convFx.OPS_ACTIONS), []);

// Lockout reset: "Other" needs a note (T6 logic); notes are at most 300.
assert.equal(view.resetFormProblem(null, ''), 'Choose a reason.');
assert.equal(view.resetFormProblem('other', '   '), 'Add a note for Other.');
assert.equal(view.resetFormProblem('other', 'Confirmed on a call'), null);
assert.equal(view.resetFormProblem('codes_not_arriving', ''), null);
assert.equal(view.resetFormProblem('codes_not_arriving', 'x'.repeat(301)), 'Keep the note to 300 characters.');
assert.deepEqual(view.resetActionInput(lockFx.LOCKED_DETAIL.challengeId, 'codes_not_arriving', '  '), { action: 'reset_lockout', challengeId: lockFx.LOCKED_DETAIL.challengeId, reasonCode: 'codes_not_arriving' });
assert.deepEqual(view.resetActionInput(lockFx.LOCKED_DETAIL.challengeId, 'other', ' On a call '), { action: 'reset_lockout', challengeId: lockFx.LOCKED_DETAIL.challengeId, reasonCode: 'other', note: 'On a call' });

assert.equal(view.revealReasonProblem('too short'), 'At least 20 characters (9 so far).');
assert.equal(view.revealReasonProblem('A callback the worker asked for today'), null);
assert.equal(view.revealReasonProblem('x'.repeat(501)), 'At most 500 characters.');

assert.equal(view.attemptsText(3, 3), '3 of 3');
assert.equal(view.typicalVerifyText(41), '41 min');
assert.equal(view.typicalVerifyText(40.6), '41 min');
assert.equal(view.typicalVerifyText(null), 'Not enough data yet');
assert.equal(view.lockoutHeading('locked'), 'Worker is locked out of verification');
assert.equal(view.lockoutHeading('verified'), 'Worker identity verification');
assert.equal(view.lockoutSubtitle(lockFx.LOCKED_DETAIL), 'Identity verification on WhatsApp · Spanish · locked automatically after 3 failed attempts');
assert.equal(view.lockoutSubtitle(lockFx.NO_HISTORY_DETAIL), 'Identity verification on WhatsApp · Spanish');
assert.deepEqual(
  ['locked', 'stuck_at_code', 'in_progress', 'verified', 'expired', 'superseded'].map(view.lockoutTone),
  ['danger', 'warning', 'info', 'success', 'neutral', 'neutral'],
);

// --- Task 5: tabs, filters and the action seam --------------------------------
const { InboxActionsContext } = await load('src/components/inbox/inbox-actions-context.ts');
const idleActions = { pending: null, run: async () => ({ ok: true, kind: 'done' }) };
/** Renders a control inside the action seam, as InboxActionsProvider would. */
const inActions = (element, value = idleActions) => createElement(InboxActionsContext, { value }, element);

const { InboxTabs } = await load('src/components/inbox/InboxTabs.tsx');
const tabsHtml = render(createElement(InboxTabs, {
  query: { tab: 'support', status: 'resolved', q: 'S-1' },
  counts: { all: 9, support: 4, reports: 3, lockouts: 2 },
}));
const tabLinks = anchors(tabsHtml);
assert.deepEqual(tabLinks.map((link) => link.href), [
  '/inbox?status=resolved&q=S-1',
  '/inbox?tab=support&status=resolved&q=S-1',
  '/inbox?tab=reports&status=resolved&q=S-1',
  '/inbox?tab=lockouts&status=resolved&q=S-1',
], 'a tab keeps the status and the search, and drops the page cursor');
const activeTabs = tabLinks.filter((link) => /aria-current="page"/.test(link.attrs));
assert.equal(activeTabs.length, 1, 'one tab is current');
assert.ok(activeTabs[0].text.includes('Support'), 'the current tab is the query tab');
for (const [label, total] of [['All', '9'], ['Support', '4'], ['Problem reports', '3'], ['Lockouts', '2']]) {
  const link = tabLinks.find((candidate) => candidate.text.includes(label));
  assert.ok(link && link.text.includes(total), `${label} shows its count ${total}`);
}
for (const link of tabLinks) assert.match(link.attrs, /data-prefetch="false"/, 'tab links never prefetch');

const { InboxFilters } = await load('src/components/inbox/InboxFilters.tsx');
const filtersHtml = render(createElement(InboxFilters, { query: { tab: 'reports', status: 'resolved', q: 'R-88' } }));
assert.match(filtersHtml, /<form(?=[^>]*role="search")(?=[^>]*method="get")(?=[^>]*action="\/inbox")/, 'a plain GET search form');
assert.match(filtersHtml, /placeholder="Search by reference, e.g. S-124"/, 'the spec placeholder');
assert.match(filtersHtml, /<label[^>]*for="inbox-search"[^>]*>Search by reference<\/label>/, 'the search box has a label');
assert.match(filtersHtml, /<input(?=[^>]*name="q")(?=[^>]*value="R-88")/, 'the search is filled in');
assert.match(filtersHtml, /<input(?=[^>]*type="hidden")(?=[^>]*name="tab")(?=[^>]*value="reports")/, 'the tab survives a search');
assert.match(filtersHtml, /<label[^>]*for="inbox-status"[^>]*>Status<\/label>/);
assert.match(filtersHtml, /<option(?=[^>]*selected="")(?=[^>]*value="resolved")[^>]*>Resolved<\/option>/, 'the current status is selected');
for (const label of ['Open + waiting', 'Waiting on worker', 'Resolved', 'All']) assert.ok(textOf(filtersHtml).includes(label), label);
button(filtersHtml, 'Apply filters');
const clear = anchors(filtersHtml).find((link) => link.text === 'Clear');
assert.ok(clear && clear.href === '/inbox?tab=reports', 'Clear keeps the tab only');
assert.match(clear.attrs, /data-prefetch="false"/);
const plainFilters = render(createElement(InboxFilters, { query: { tab: 'all', status: 'waiting' } }));
assert.doesNotMatch(plainFilters, /name="tab"/, 'no hidden tab on All');
assert.equal(anchors(plainFilters).length, 0, 'no Clear link when nothing is narrowed');

// --- Task 6: the reply box (T2, T4a) -------------------------------------------
const { ReplyComposer } = await load('src/components/inbox/ReplyComposer.tsx');
const composer = (conversation, value) => render(inActions(createElement(ReplyComposer, {
  caseId: conversation.caseId,
  language: conversation.language,
  languageLabel: conversation.languageLabel,
  reply: conversation.reply,
  actions: conversation.actions,
  startsConversation: !view.hasWorkerMessages(conversation.messages),
}), value));

// T2: template mode shows the K2 preview, the 250 counter and the newline note.
const templateHtml = composer(convFx.CLOSED_CONVERSATION);
const templateText = textOf(templateHtml);
assert.ok(templateText.includes('Worker will see'), 'T2: template mode shows what the worker sees');
assert.match(
  templateHtml,
  /Jale Soporte: «<em[^>]*>your reply<\/em>»\. Responde a este mensaje si necesitas más ayuda\./,
  'T2: the reply sits inside the template text, with the template’s own quote marks',
);
assert.doesNotMatch(templateHtml, /««|»»|“«|»”/, 'T2: no quote marks are added around the template’s own');
assert.ok(templateText.includes('0 / 250'), 'T2: the counter runs against the template cap');
assert.ok(templateText.includes('Line breaks become spaces.'), 'T2: the newline note');
assert.ok(templateText.includes('Reply (Spanish)'), 'the label names the language');
assert.match(templateHtml, /placeholder="Escribe tu respuesta…"/);
button(templateHtml, 'Send in template');

// T2: freeform mode: 1000, no preview, no note.
const freeformHtml = composer(convFx.OPEN_CONVERSATION);
const freeformText = textOf(freeformHtml);
assert.ok(freeformText.includes('0 / 1000'), 'T2: the freeform cap');
assert.ok(!freeformText.includes('Worker will see'), 'T2: no preview while the window is open');
assert.ok(!freeformText.includes('Line breaks become spaces.'), 'T2: no newline note while the window is open');
assert.equal(isDisabled(button(freeformHtml, 'Send reply')), true, 'nothing to send yet');
assert.equal(isDisabled(button(freeformHtml, 'Ask for more info')), true, 'nothing to ask yet');
assert.equal(isDisabled(button(freeformHtml, 'Resolve and close')), false, 'resolve needs no text');
assert.ok(!freeformText.includes('Reply to start the conversation'));
assert.match(freeformHtml, /role="status"/, 'a live region for send results is always present');
assert.match(freeformHtml, /role="alert"/, 'an alert region for failures is always present');

// A case with no worker message yet (Review Focus 2).
const firstHtml = composer(convFx.FROM_LOCKOUT_CONVERSATION);
assert.ok(textOf(firstHtml).includes('Reply to start the conversation'));
assert.match(firstHtml, /Jale Support replied to your help request: “<em[^>]*>your reply<\/em>”\. Reply to this message if you need more help\./);
assert.match(firstHtml, /placeholder="Write your reply…"/);

// T4a: a read-only role sees every action disabled, with the server's reason once.
const readonlyHtml = composer({ ...convFx.OPEN_CONVERSATION, actions: convFx.READONLY_ACTIONS });
for (const name of ['Send reply', 'Ask for more info', 'Resolve and close']) {
  assert.equal(isDisabled(button(readonlyHtml, name)), true, `T4: ${name} is disabled for read-only`);
}
assert.equal(occurrences(textOf(readonlyHtml), convFx.READONLY_REASON), 1, 'T4: the reason shows once');
assert.match(readonlyHtml, /<textarea[^>]*disabled=""/, 'T4: nothing can be written');
const reasonsId = /aria-describedby="([^"]*)"/.exec(button(readonlyHtml, 'Resolve and close').attrs)?.[1] ?? '';
assert.ok(reasonsId && readonlyHtml.includes(`id="${reasonsId.split(' ').pop()}"`), 'T4: the disabled button points at its reason');

// An action the server did not send is disabled with a reason, never hidden.
const missingHtml = composer({ ...convFx.OPEN_CONVERSATION, actions: [] });
assert.equal(isDisabled(button(missingHtml, 'Resolve and close')), true);
assert.ok(textOf(missingHtml).includes('Not available for this case.'));

// While an action runs, the others wait.
const busyHtml = composer(convFx.OPEN_CONVERSATION, { pending: 'resolve', run: idleActions.run });
assert.equal(isDisabled(button(busyHtml, 'Resolve and close')), true);

// Review Focus 1: a window that closed after load switches the counter to the server's cap.
{
  const composerSource = readSource('src/components/inbox/ReplyComposer.tsx');
  assert.match(composerSource, /setClosedLate\(result\.maxChars \?\? TEMPLATE_REPLY_MAX_CHARS\)/, 'the late-close cap falls back to the shared constant');
  assert.match(composerSource, /import \{ TEMPLATE_REPLY_MAX_CHARS \} from '@\/lib\/support-reply'/, 'the shared constant is imported');
  assert.doesNotMatch(composerSource, /\b250\b/, 'the reply box has no literal 250');
}

// --- Task 7: the chat window banner (T3) ---------------------------------------
const { WindowBanner } = await load('src/components/inbox/WindowBanner.tsx');
const banner = (props) => render(createElement(WindowBanner, props));
assert.equal(
  textOf(banner({ open: true, languageLabel: 'Spanish', timing: '20h 48m' })),
  'Chat window open · closes in 20h 48m. Your reply is sent exactly as written.',
  'T3: the open copy',
);
assert.equal(
  textOf(banner({ open: false, languageLabel: 'Spanish', timing: '2h ago' })),
  'The 24-hour chat window closed 2h ago. WhatsApp now only accepts the approved support-reply template, so your text goes inside it, in Spanish. When the worker answers, the chat reopens in support mode.',
  'T3: the closed copy names the language',
);
assert.ok(textOf(banner({ open: false, languageLabel: 'English', timing: '1d ago' })).includes('goes inside it, in English.'), 'T3: English');
assert.ok(
  textOf(banner({ open: false, languageLabel: 'English', timing: null })).startsWith('The 24-hour chat window is closed. WhatsApp now only accepts'),
  'a case with no window history never prints "closed null"',
);
assert.equal(textOf(banner({ open: true, languageLabel: 'Spanish', timing: null })), 'Chat window open. Your reply is sent exactly as written.');
assert.match(banner({ open: true, languageLabel: 'Spanish', timing: '1h 0m' }), /<svg[^>]*aria-hidden="true"/, 'an icon as well as colour');
assert.match(banner({ open: false, languageLabel: 'Spanish', timing: '2h ago' }), /<svg[^>]*aria-hidden="true"/);

// --- Task 8: thread, bubbles and media (T5) ------------------------------------
const { ConversationThread } = await load('src/components/inbox/ConversationThread.tsx');
const thread = (conversation) => render(inActions(createElement(ConversationThread, {
  caseId: conversation.caseId,
  messages: conversation.messages,
  workerLabel: conversation.worker.label,
})));
const openThread = thread(convFx.OPEN_CONVERSATION);
assert.match(openThread, /<div(?=[^>]*role="region")(?=[^>]*aria-label="Messages, oldest first")(?=[^>]*tabindex="0")/, 'a named, keyboard-scrollable region');
const bubbleTags = [...openThread.matchAll(/<li\b([^>]*)>/g)].map((match) => match[1]);
assert.equal(bubbleTags.length, convFx.OPEN_CONVERSATION.messages.length, 'one item per message');
assert.deepEqual(
  bubbleTags.map((attrs) => /data-from="(\w+)"/.exec(attrs)?.[1]),
  convFx.OPEN_CONVERSATION.messages.map((m) => m.from),
  'oldest first, as the server sends them',
);
for (const [from, side] of [['worker', 'justify-start'], ['admin', 'justify-end'], ['system', 'justify-center']]) {
  assert.ok(bubbleTags.some((attrs) => attrs.includes(`data-from="${from}"`) && attrs.includes(side)), `${from} messages sit ${side}`);
}
const openText = textOf(openThread);
assert.ok(openText.includes('Worker #1042'), 'a worker bubble names the worker');
assert.ok(openText.includes('Ops admin'), 'an admin bubble names the role');
assert.ok(openText.includes('Delivered'), 'an admin bubble shows its delivery state');
assert.ok(openText.includes('Worker sent SOPORTE and entered support mode'), 'system notes show');
assert.equal((openThread.match(/<time\b/g) ?? []).length, convFx.OPEN_CONVERSATION.messages.length, 'every message has a machine-readable time');

// T5: media is a button that opens privately, never an embedded image.
assert.doesNotMatch(openThread, /<img\b/, 'T5: no embedded media');
assert.equal(isDisabled(button(openThread, 'Photo · open privately')), false, 'T5: a photo opens through a button');
assert.ok(openText.includes('Voice note · Removed after 90 days'), 'T5: expired media says so');
assert.equal(buttons(openThread).filter((b) => b.text.includes('Voice note')).length, 0, 'T5: expired media has no button');
assert.match(
  readSource('src/components/inbox/MediaMessage.tsx'),
  /window\.open\(result\.url, '_blank', 'noopener,noreferrer'\)/,
  'T5: the presigned link opens in a new tab with no opener',
);

const closedText = textOf(thread(convFx.CLOSED_CONVERSATION));
assert.ok(closedText.includes('Waiting for the worker to reply'), 'waiting_for_window reads as the spec says');
assert.ok(closedText.includes('Sent · sent in template'), 'a template send says so');
assert.ok(closedText.includes('Superadmin'), 'a superadmin byline is not "Superadmin admin"');
assert.ok(!closedText.includes('Superadmin admin'));
assert.ok(textOf(thread({ ...convFx.FROM_LOCKOUT_CONVERSATION, messages: [] })).includes('No messages yet.'), 'an empty thread says so');
assert.doesNotMatch(readSource('src/components/inbox/ThreadScroller.tsx'), /\.focus\(/, 'auto-scroll never moves focus');

// --- Task 9: phone reveal (T4b) -------------------------------------------------
const { RevealPhoneDialog } = await load('src/components/inbox/RevealPhoneDialog.tsx');
const reveal = (action) => render(inActions(createElement(RevealPhoneDialog, { caseId: convFx.CASE_OPEN, action })));
const revealOps = reveal({ id: 'reveal_phone', enabled: true });
assert.ok(textOf(revealOps).includes('Phone'), 'the phone row');
assert.ok(textOf(revealOps).includes('Hidden'), 'the phone is hidden by default');
assert.equal(isDisabled(button(revealOps, 'Reveal phone (logged)')), false);
assert.doesNotMatch(revealOps, /role="dialog"/, 'the dialog renders only when opened');
const revealRo = reveal({ id: 'reveal_phone', enabled: false, reason: convFx.READONLY_REASON });
const revealButton = button(revealRo, 'Reveal phone (logged)');
assert.equal(isDisabled(revealButton), true, 'T4: reveal is disabled for read-only');
assert.ok(textOf(revealRo).includes(convFx.READONLY_REASON), 'T4: with the server’s reason');
const revealReasonId = /aria-describedby="([^"]+)"/.exec(revealButton.attrs)?.[1];
assert.ok(revealReasonId && revealRo.includes(`id="${revealReasonId}"`), 'T4: the button points at its reason');
const revealSource = readSource('src/components/inbox/RevealPhoneDialog.tsx');
assert.match(revealSource, /The reason is recorded\. Do not include personal details\./, 'the reason field warns that it is recorded');
assert.match(revealSource, /minLength=\{REVEAL_REASON_MIN\}/);
assert.match(revealSource, /maxLength=\{REVEAL_REASON_MAX\}/);
assert.match(revealSource, /justification: reason\.trim\(\)/);
assert.doesNotMatch(revealSource, /localStorage|sessionStorage|indexedDB|console\./, 'the phone lives in state only');

// --- Task 10: lockout reset (T6, T4c), open support, timeline -----------------
const { LockoutResetForm } = await load('src/components/inbox/LockoutResetForm.tsx');
const resetForm = (props = {}) => render(inActions(createElement(LockoutResetForm, {
  challengeId: lockFx.LOCKED_DETAIL.challengeId,
  languageLabel: 'Spanish',
  attemptsAllowed: 3,
  action: { id: 'reset_lockout', enabled: true },
  ...props,
})));
const SUBMIT = 'Reset and notify worker';
const { LOCKOUT_RESET_REASONS } = await load('src/lib/lockout-reasons.ts');
assert.deepEqual(LOCKOUT_RESET_REASONS, lockFx.LOCKOUT_REASONS, 'the fixture reasons equal the client-safe K2.6 list');
assert.match(readSource('src/components/inbox/LockoutResetForm.tsx'), /from '@\/lib\/lockout-reasons';/, 'the client form reads the reasons from the client-safe module');
assert.doesNotMatch(readSource('src/components/inbox/LockoutResetForm.tsx'), /^import \{[^}]*\} from '@\/lib\/server\//m, 'a client component never imports a server value');
const noReason = resetForm();
assert.ok(
  textOf(noReason).includes('Gives the worker 3 new attempts and tells them on WhatsApp, in Spanish. The reason is counted in Analytics.'),
  'the helper text names the language',
);
assert.equal((noReason.match(/<input(?=[^>]*type="radio")(?=[^>]*name="reasonCode")/g) ?? []).length, 5, 'reasons are radios (the spec, not the prototype select)');
for (const reason of lockFx.LOCKOUT_REASONS) assert.ok(textOf(noReason).includes(reason.label), reason.label);
assert.equal(isDisabled(button(noReason, SUBMIT)), true, 'T6: a reason comes first');

const otherEmpty = resetForm({ defaultReason: 'other' });
assert.equal(isDisabled(button(otherEmpty, SUBMIT)), true, 'T6: "Other" needs a note before submit is enabled');
assert.match(otherEmpty, /<textarea(?=[^>]*required="")/, 'T6: the note is required for Other');
assert.ok(textOf(otherEmpty).includes('Add a note for Other.'), 'T6: the form says why');
const otherNoted = resetForm({ defaultReason: 'other', defaultNote: 'Confirmed on a call' });
assert.equal(isDisabled(button(otherNoted, SUBMIT)), false, 'T6: with a note, Other can be sent');
const plainReason = resetForm({ defaultReason: 'codes_not_arriving' });
assert.equal(isDisabled(button(plainReason, SUBMIT)), false, 'any other reason needs no note');
assert.doesNotMatch(plainReason, /<textarea(?=[^>]*required="")/);
assert.match(plainReason, /<input(?=[^>]*type="radio")(?=[^>]*value="codes_not_arriving")(?=[^>]*checked="")/, 'the chosen reason is checked');
assert.match(plainReason, /<textarea(?=[^>]*maxLength="300"|[^>]*maxlength="300")/i, 'the note is capped at 300');

const resetReadonly = resetForm({ defaultReason: 'codes_not_arriving', action: { id: 'reset_lockout', enabled: false, reason: convFx.READONLY_REASON } });
assert.equal(isDisabled(button(resetReadonly, SUBMIT)), true, 'T4: reset is disabled for read-only');
assert.ok(textOf(resetReadonly).includes(convFx.READONLY_REASON), 'T4: with the server’s reason');

const { OpenSupportButton } = await load('src/components/inbox/OpenSupportButton.tsx');
const openSupport = (props) => render(inActions(createElement(OpenSupportButton, { challengeId: lockFx.LOCKED_DETAIL.challengeId, ...props })));
const openNew = openSupport({ supportCaseId: null, action: { id: 'open_support_from_lockout', enabled: true } });
assert.equal(isDisabled(button(openNew, 'Open a support conversation')), false);
const openExisting = anchors(openSupport({ supportCaseId: convFx.CASE_FROM_LOCKOUT, action: { id: 'open_support_from_lockout', enabled: true } }));
assert.equal(openExisting.length, 1, 'an open case is a plain link');
assert.equal(openExisting[0].href, `/inbox/support/${convFx.CASE_FROM_LOCKOUT}`);
assert.match(openExisting[0].attrs, /data-prefetch="false"/);
const openRo = openSupport({ supportCaseId: null, action: { id: 'open_support_from_lockout', enabled: false, reason: convFx.READONLY_REASON } });
assert.equal(isDisabled(button(openRo, 'Open a support conversation')), true, 'T4: disabled for read-only');
assert.ok(textOf(openRo).includes(convFx.READONLY_REASON));

const { LockoutTimeline } = await load('src/components/inbox/LockoutTimeline.tsx');
const timelineHtml = render(createElement(LockoutTimeline, { timeline: lockFx.LOCKED_DETAIL.timeline }));
const timelineText = textOf(timelineHtml);
let lastIndex = -1;
for (const event of lockFx.LOCKED_DETAIL.timeline) {
  const index = timelineText.indexOf(event.title);
  assert.ok(index > lastIndex, `"${event.title}" in order`);
  lastIndex = index;
}
assert.equal((timelineHtml.match(/<time\b/g) ?? []).length, lockFx.LOCKED_DETAIL.timeline.length);
assert.doesNotMatch(timelineText, /\bnull\b/, 'a missing detail prints nothing');
assert.ok(textOf(render(createElement(LockoutTimeline, { timeline: [] }))).includes('No events recorded.'));

// --- Phase B review 1: the media link lifetime comes from expiresAt -------------
const MEDIA_NOW = Date.parse('2026-10-14T12:00:00.000Z');
assert.equal(view.mediaLinkLifetimeText('2026-10-14T12:02:30.000Z', MEDIA_NOW), 'The link stops working in 3 minutes.', '150 s ahead rounds up to 3 minutes');
assert.equal(view.mediaLinkLifetimeText('2026-10-14T12:00:10.000Z', MEDIA_NOW), 'The link stops working in 1 minute.', '10 s ahead is 1 minute, singular');
assert.equal(view.mediaLinkLifetimeText('2026-10-14T12:05:00.000Z', MEDIA_NOW), 'The link stops working in 5 minutes.', 'an exact minute count is not rounded up');
assert.equal(view.mediaLinkLifetimeText('2026-10-14T11:59:00.000Z', MEDIA_NOW), 'The link stops working in 1 minute.', 'an expiry already past still reads at least 1 minute');
assert.equal(view.mediaLinkLifetimeText('not a date', MEDIA_NOW), 'The link stops working in 1 minute.', 'an unreadable expiry never prints NaN');
assert.doesNotMatch(readSource('src/components/inbox/MediaMessage.tsx'), /after 5 minutes/, 'no fixed lifetime in the component');

// --- Task 11: adminFetchJson results, the live countdown ------------------------
const { toRunResult } = await load('src/components/inbox/inbox-run-result.ts');
const mediaOk = { ok: true, kind: 'media', url: 'https://bucket.example.test/x', expiresAt: '2026-10-14T15:05:00.000Z' };
for (const [outcome, expected, why] of [
  [{ kind: 'redirecting' }, { ok: false, error: 'redirecting' }, '401: leaving for sign-in'],
  [{ kind: 'network' }, { ok: false, error: 'network' }, 'fetch threw'],
  [{ kind: 'ok', status: 200, data: { ok: true, kind: 'done' } }, { ok: true, kind: 'done' }, 'a K2.7 success'],
  [{ kind: 'ok', status: 200, data: mediaOk }, mediaOk, 'a media link'],
  [{ kind: 'error', status: 409, data: { ok: false, error: 'case_closed' } }, { ok: false, error: 'case_closed' }, 'a K2.7 refusal'],
  [{ kind: 'error', status: 400, data: { ok: false, error: 'reply_too_long_for_template', maxChars: 250 } }, { ok: false, error: 'reply_too_long_for_template', maxChars: 250 }, 'the cap comes through'],
  [{ kind: 'ok', status: 204, data: null }, { ok: false, error: 'unexpected', status: 204 }, 'no body'],
  [{ kind: 'error', status: 501, data: { error: 'not_implemented' } }, { ok: false, error: 'unexpected', status: 501 }, 'the step-0 stub'],
  [{ kind: 'error', status: 502, data: null }, { ok: false, error: 'unexpected', status: 502 }, 'an edge page'],
  [{ kind: 'error', status: 403, data: { ok: true, kind: 'done' } }, { ok: false, error: 'unexpected', status: 403 }, 'success body on an error status'],
  [{ kind: 'ok', status: 200, data: { ok: false, error: 'case_closed' } }, { ok: false, error: 'unexpected', status: 200 }, 'refusal body on a 2xx'],
  [{ kind: 'ok', status: 200, data: { ...mediaOk, url: 'http://x.test' } }, { ok: false, error: 'unexpected', status: 200 }, 'a non-https link'],
]) {
  assert.deepEqual(toRunResult(outcome), expected, why);
}

// One request id per attempt-until-known (K2 CCR-3; the server is idempotent by requestId for 24 h).
for (const unknown of [{ ok: false, error: 'network' }, { ok: false, error: 'unexpected', status: 502 }, { ok: false, error: 'unexpected', status: 500 }, { ok: false, error: 'unexpected', status: 0 }]) {
  assert.equal(view.isUnknownOutcome(unknown), true, `unknown: ${JSON.stringify(unknown)}`);
}
for (const known of [
  { ok: true, kind: 'done' }, mediaOk, { ok: false, error: 'case_closed' }, { ok: false, error: 'invalid_input' },
  { ok: false, error: 'reply_too_long_for_template', maxChars: 250 }, { ok: false, error: 'redirecting' }, { ok: false, error: 'busy' },
  { ok: false, error: 'unexpected', status: 200 }, { ok: false, error: 'unexpected', status: 403 }, { ok: false, error: 'unexpected', status: 499 },
]) {
  assert.equal(view.isUnknownOutcome(known), false, `known: ${JSON.stringify(known)}`);
}
assert.equal(view.actionKey({ action: 'reply', caseId: 'c1', text: 'Hola' }), view.actionKey({ text: 'Hola', caseId: 'c1', action: 'reply' }), 'key order does not change the key');
assert.notEqual(view.actionKey({ action: 'reply', caseId: 'c1', text: 'Hola' }), view.actionKey({ action: 'reply', caseId: 'c1', text: 'Hola!' }), 'a changed text is another key');
assert.notEqual(view.actionKey({ action: 'reply', caseId: 'c1', text: 'Hola' }), view.actionKey({ action: 'reply', caseId: 'c2', text: 'Hola' }), 'a changed target is another key');
assert.notEqual(view.actionKey({ action: 'reply', caseId: 'c1', text: 'Hola' }), view.actionKey({ action: 'request_info', caseId: 'c1', text: 'Hola' }), 'a changed action is another key');
{
  // The provider's sequence: pick an id, run, remember it only after an unknown outcome.
  let issued = 0;
  const newId = () => `id-${++issued}`;
  let retry = null;
  const attempt = (input, result) => {
    const key = view.actionKey(input);
    const requestId = view.chooseRequestId(retry, key, newId);
    retry = view.isUnknownOutcome(result) ? { key, requestId } : null;
    return requestId;
  };
  const reply = { action: 'reply', caseId: 'c1', text: 'Hola' };
  assert.equal(attempt(reply, { ok: false, error: 'network' }), 'id-1', 'first attempt gets a new id');
  assert.equal(attempt(reply, { ok: false, error: 'network' }), 'id-1', 'same key after network: same id');
  assert.equal(attempt({ text: 'Hola', caseId: 'c1', action: 'reply' }, { ok: false, error: 'unexpected', status: 502 }), 'id-1', 'same key after an unexpected 502: same id');
  assert.equal(attempt(reply, { ok: false, error: 'case_closed' }), 'id-1', 'the retry still used the remembered id; the K2.7 answer ends it');
  assert.equal(attempt(reply, { ok: true, kind: 'done' }), 'id-2', 'same key after a K2.7 answer: a new id');
  assert.equal(attempt(reply, { ok: false, error: 'network' }), 'id-3', 'a fresh message after a definitive answer');
  assert.equal(attempt({ ...reply, text: 'Hola, ¿cómo estás?' }, { ok: false, error: 'network' }), 'id-4', 'different key after network: a new id');
  assert.equal(attempt({ ...reply, text: 'Hola, ¿cómo estás?' }, { ok: false, error: 'unexpected', status: 200 }), 'id-4', 'reused again');
  assert.equal(attempt({ ...reply, text: 'Hola, ¿cómo estás?' }, { ok: true, kind: 'done' }), 'id-5', 'after an unexpected 200 (a known outcome) the next attempt is new');
}
assert.equal(view.chooseRequestId(null, 'k', () => 'fresh'), 'fresh');
assert.equal(view.chooseRequestId({ key: 'k', requestId: 'old' }, 'k', () => 'fresh'), 'old');
assert.equal(view.chooseRequestId({ key: 'k', requestId: 'old' }, 'other', () => 'fresh'), 'fresh');

const { WindowCountdown } = await load('src/components/inbox/WindowCountdown.tsx');
const localTime = await load('src/lib/local-time.ts');
const countdownHtml = render(createElement(WindowCountdown, { closesAt: convFx.OPEN_CONVERSATION.window.closesAt, nowIso: inboxFx.NOW_ISO }));
assert.match(countdownHtml, new RegExp(`<time[^>]*dateTime="${convFx.OPEN_CONVERSATION.window.closesAt}"`), 'machine-readable close time');
assert.equal(textOf(countdownHtml), localTime.durationText(20 * 3600_000 + 48 * 60_000), 'server text is the time left at the page’s now');
assert.equal(textOf(render(createElement(WindowCountdown, { closesAt: '2026-10-14T14:00:00.000Z', nowIso: inboxFx.NOW_ISO }))), localTime.durationText(0), 'a passed close time shows zero');
assert.equal(textOf(render(createElement(WindowBanner, { open: true, languageLabel: 'Spanish', timing: createElement(WindowCountdown, { closesAt: convFx.OPEN_CONVERSATION.window.closesAt, nowIso: inboxFx.NOW_ISO }) }))),
  `Chat window open · closes in ${localTime.durationText(20 * 3600_000 + 48 * 60_000)}. Your reply is sent exactly as written.`, 'T3 with the live countdown');

// --- S28 FE-2 band: the last 30 minutes of the chat window ----------------------
{
  const LEAD = 30 * 60_000;
  const closes = '2026-10-15T11:48:00.000Z';
  const at = (leftMs) => new Date(Date.parse(closes) - leftMs).toISOString();
  assert.equal(view.TEMPLATE_CAP_LEAD_MS, LEAD, 'the band is the last 30 minutes (migration 122 lines 591/643 vs 812)');
  assert.equal(view.templateCapSoon(closes, at(LEAD)), true, 'exactly 30:00 left is inside the band');
  assert.equal(view.templateCapSoon(closes, at(LEAD + 1)), false, '30:00.001 left is outside the band');
  assert.equal(view.templateCapSoon(closes, at(19 * 60_000)), true, '19 minutes left');
  assert.equal(view.templateCapSoon(closes, at(20 * 3600_000 + 48 * 60_000)), false, '20h48m left');
  assert.equal(view.templateCapSoon(closes, at(0)), true, 'zero left: the page is about to refresh to closed');
  assert.equal(view.templateCapSoon(closes, at(-60_000)), true, 'already past the close counts as in the band');
  assert.equal(view.templateCapSoon('not a date', at(60_000)), false, 'no parseable close time: no band claim');
  assert.equal(view.templateCapSoon(closes, 'not a date'), false, 'no parseable now: no band claim');

  const bandCopy = (time) => `Chat window open · closes in ${time}. Keep it under 250 characters: if it doesn't reach them before the window closes, it goes inside the Jale Support template.`;
  assert.equal(
    textOf(banner({ open: true, languageLabel: 'Spanish', capSoon: true, timing: createElement(WindowCountdown, { closesAt: closes, nowIso: at(19 * 60_000) }) })),
    bandCopy(localTime.durationText(19 * 60_000)),
    'band: the new copy with the live countdown',
  );
  assert.equal(
    textOf(banner({ open: true, languageLabel: 'Spanish', capSoon: true, timing: '19m' })),
    bandCopy('19m'),
    'band: the new copy',
  );
  assert.match(banner({ open: true, languageLabel: 'Spanish', capSoon: true, timing: '19m' }), /<strong>Chat window open · closes in 19m\.<\/strong>/, 'band: the first sentence stays bold');
  assert.equal(
    textOf(banner({ open: true, languageLabel: 'Spanish', capSoon: true, timing: null })),
    "Chat window open. Keep it under 250 characters: if it doesn't reach them before the window closes, it goes inside the Jale Support template.",
    'band without a close time',
  );
  assert.equal(
    textOf(banner({ open: true, languageLabel: 'Spanish', capSoon: false, timing: '20h 48m' })),
    'Chat window open · closes in 20h 48m. Your reply is sent exactly as written.',
    'outside the band with capSoon false: the old copy',
  );
  assert.equal(
    textOf(banner({ open: false, languageLabel: 'English', capSoon: true, timing: '1h ago' })),
    textOf(banner({ open: false, languageLabel: 'English', timing: '1h ago' })),
    'the closed banner ignores the band flag',
  );

  const bandComposer = (capSoon, conversation = convFx.OPEN_CONVERSATION) => render(inActions(createElement(ReplyComposer, {
    caseId: conversation.caseId,
    language: conversation.language,
    languageLabel: conversation.languageLabel,
    reply: conversation.reply,
    actions: conversation.actions,
    startsConversation: !view.hasWorkerMessages(conversation.messages),
    capSoon,
  })));
  const inBand = bandComposer(true);
  assert.ok(textOf(inBand).includes('0 / 250'), 'band: the counter reads 250 from the first render');
  assert.ok(!textOf(inBand).includes('0 / 1000'), 'band: no 1000 counter');
  button(inBand, 'Send in template');
  const outBand = bandComposer(false);
  assert.ok(textOf(outBand).includes('0 / 1000'), 'outside the band: the freeform cap');
  button(outBand, 'Send reply');

  const pageSource = readSource('src/app/(console)/inbox/support/[id]/page.tsx');
  assert.match(pageSource, /capSoon\s*=\s*chat\.open\s*&&\s*chat\.closesAt\s*!==\s*null\s*&&\s*templateCapSoon\(chat\.closesAt,\s*nowIso\)/, 'the page derives the band from the same nowIso as the countdown');
  assert.match(pageSource, /<WindowBanner[^>]*capSoon=\{capSoon\}/, 'the banner gets the band flag');
  assert.match(pageSource, /<ReplyComposer[^>]*capSoon=\{capSoon\}/, 'the composer gets the band flag');
  const countdownSource = readSource('src/components/inbox/WindowCountdown.tsx');
  assert.match(countdownSource, /const crossedBand = useRef\(false\)/, 'a guarded one-shot ref for the band refresh');
  assert.match(countdownSource, /TEMPLATE_CAP_LEAD_MS/, 'the countdown uses the shared lead constant');
  assert.match(countdownSource, /crossedBand\.current/, 'the band refresh is guarded by its ref');
}

const providerSource = readSource('src/components/inbox/InboxActionsProvider.tsx');
assert.match(providerSource, /adminFetchJson<InboxActionResult>\('\/api\/inbox-actions'/, 'actions post to their K2.7 route through adminFetchJson');
assert.match(providerSource, /chooseRequestId\(/, 'the request id is chosen by chooseRequestId (reused until the outcome is known)');
assert.match(providerSource, /isUnknownOutcome\(/, 'the provider remembers the id only after an unknown outcome');

// --- Task 12: the Inbox table and pager (T1) ------------------------------------
const { InboxPager, InboxTable } = await load('src/components/inbox/InboxTable.tsx');
const tableHtml = render(createElement(InboxTable, { items: inboxFx.INBOX_ITEMS, nowIso: inboxFx.NOW_ISO }));
const rows = anchors(tableHtml);
assert.deepEqual(rows.map((row) => row.href), inboxFx.INBOX_ITEMS.map((item) => item.href), 'T1: rows keep the server order (oldest wait first) and each kind opens its own view');
for (const row of rows) assert.match(row.attrs, /data-prefetch="false"/, 'T1: rows never prefetch (a detail page records a read)');
assert.equal(occurrences(tableHtml, '<span class="sr-only">Unread</span>'), inboxFx.INBOX_ITEMS.filter((item) => item.unread).length, 'T1: one sr-only "Unread" per unread row');
inboxFx.INBOX_ITEMS.forEach((item, index) => {
  const row = rows[index];
  assert.equal(row.text.includes('Unread'), item.unread, `T1: ${item.ref} unread is ${item.unread}`);
  for (const part of [item.typeLabel, item.subject, item.ref, item.from, item.statusLabel]) assert.ok(row.text.includes(part), `${item.ref} shows ${part}`);
  if (item.waitingSince) assert.ok(row.inner.includes(`dateTime="${item.waitingSince}"`), `${item.ref} waits through LocalTime`);
  else assert.ok(row.text.includes('—'), `${item.ref} has no wait`);
});
assert.match(tableHtml, /<span class="[^"]*\btruncate\b[^"]*">Onboarding stopped/, 'a long subject truncates (Review Focus 5)');
assert.match(tableHtml, /class="[^"]*\bmin-w-0\b/, 'the subject column can shrink');
assert.match(tableHtml, /<div aria-hidden="true" class="hidden/, 'the column header is visual only and hidden on small screens');
assert.doesNotMatch(textOf(tableHtml), /\bnull\b|\bundefined\b|NaN/, 'no raw empty values (Review Focus 3)');

const pagerFirst = render(createElement(InboxPager, { query: { tab: 'all', status: 'waiting' }, shown: 6, total: 9, nextBefore: 'c2FtcGxl' }));
assert.ok(textOf(pagerFirst).includes('Showing 6 of 9 · unread items are marked with a blue dot'));
assert.deepEqual(anchors(pagerFirst).map((link) => [link.text, link.href]), [['Next', '/inbox?before=c2FtcGxl']]);
const pagerLater = render(createElement(InboxPager, { query: { tab: 'support', status: 'waiting', before: 'x' }, shown: 3, total: 28 }));
assert.deepEqual(anchors(pagerLater).map((link) => [link.text, link.href]), [['Newest', '/inbox?tab=support']]);
for (const link of anchors(pagerLater)) assert.match(link.attrs, /data-prefetch="false"/);
assert.equal(render(createElement(InboxPager, { query: { tab: 'all', status: 'waiting' }, shown: 0, total: 0 })), '', 'no footer on an empty first page');

// --- Task 13: the conversation's context panel -----------------------------------
const { CaseContextPanel } = await load('src/components/inbox/CaseContextPanel.tsx');
const contextPanel = (conversation, role = 'admin_ops') => render(inActions(createElement(CaseContextPanel, { conversation, nowIso: inboxFx.NOW_ISO, role })));
const contextOpen = textOf(contextPanel(convFx.OPEN_CONVERSATION));
for (const part of ['Worker #1042', 'WhatsApp · Spanish', 'Identity check (step 5 of 8)', '2 failed codes today', 'Phone', 'Hidden', 'Reveal phone (logged)', '3 messages · 2 attachments', '2, by email', 'S-97 · Resolved']) {
  assert.ok(contextOpen.includes(part), `the context panel shows "${part}"`);
}
const earlier = anchors(contextPanel(convFx.OPEN_CONVERSATION)).find((link) => link.text.includes('S-97'));
assert.ok(earlier && earlier.href === `/inbox/support/${convFx.OPEN_CONVERSATION.earlierCases[0].caseId}`, 'earlier cases link to their own view');
assert.match(earlier.attrs, /data-prefetch="false"/);
const contextFirst = textOf(contextPanel(convFx.FROM_LOCKOUT_CONVERSATION));
for (const part of ['Unregistered number', 'Not registered', 'Not waiting', 'No one yet', '0 messages', 'No earlier cases.']) {
  assert.ok(contextFirst.includes(part), `an unregistered first contact shows "${part}"`);
}
assert.ok(!contextFirst.includes('failed code'), 'no verification row without a count');
assert.doesNotMatch(contextFirst, /\bnull\b|\bundefined\b|NaN/, 'Review Focus 3: null facts never print');

// Amendment C: the superadmin-only link to the person's access history.
const historyLink = (conversation, role) => anchors(contextPanel(conversation, role)).find((link) => link.text.includes('Access history for this person'));
const superLink = historyLink(convFx.OPEN_CONVERSATION, 'admin_superadmin');
assert.ok(superLink, 'a superadmin sees "Access history for this person"');
assert.equal(superLink.href, `/security?subject=${convFx.OPEN_CONVERSATION.worker.userId}`, 'the link filters the history to this person');
assert.match(superLink.attrs, /data-prefetch="false"/, 'the access history link is not prefetched');
assert.equal(historyLink(convFx.OPEN_CONVERSATION, 'admin_ops'), undefined, 'ops never see the access history link');
assert.equal(historyLink(convFx.OPEN_CONVERSATION, 'admin_readonly'), undefined, 'readonly never sees the access history link');
assert.equal(historyLink(convFx.FROM_LOCKOUT_CONVERSATION, 'admin_superadmin'), undefined, 'no link without a user id');
const notUuid = { ...convFx.OPEN_CONVERSATION, worker: { ...convFx.OPEN_CONVERSATION.worker, userId: 'not-a-uuid' } };
assert.equal(historyLink(notUuid, 'admin_superadmin'), undefined, 'no link when the user id is not a UUID');

// --- Task 14: lockout stat tiles ---------------------------------------------------
const { LockoutStats } = await load('src/components/inbox/LockoutStats.tsx');
const statsLocked = textOf(render(createElement(LockoutStats, { detail: lockFx.LOCKED_DETAIL, nowIso: inboxFx.NOW_ISO })));
for (const part of ['Attempts used', '3 of 3', 'In verification so far', localTime.durationText(51 * 3600_000), 'Earlier resets', 'Typical time to verify', '41 min', 'Median over the last 30 days']) {
  assert.ok(statsLocked.includes(part), `the stat tiles show "${part}"`);
}
const statsNoHistory = textOf(render(createElement(LockoutStats, { detail: lockFx.NO_HISTORY_DETAIL, nowIso: inboxFx.NOW_ISO })));
assert.ok(statsNoHistory.includes('Not enough data yet'), 'no median yet');
assert.doesNotMatch(statsNoHistory, /\bnull\b|\bundefined\b|NaN/, 'Review Focus 3');

// --- Task 16: report filters on the Reports tab (amendment D: reportStatus) -------
const NO_REPORT = { reportStatus: null, role: null, category: null, verified: null, number: null, numberInput: '', numberInvalid: false };
const reportFilterValues = { reportStatus: 'looking', role: 'worker', category: 'uploads', verified: true, number: 1042, numberInput: '1042', numberInvalid: false };
const reportFiltersHtml = render(createElement(InboxFilters, { query: { tab: 'reports', status: 'all', report: reportFilterValues } }));
assert.equal((reportFiltersHtml.match(/<form\b/g) ?? []).length, 1, 'one filter form with one Apply');
assert.match(reportFiltersHtml, /<input(?=[^>]*type="hidden")(?=[^>]*name="tab")(?=[^>]*value="reports")/, 'the form keeps the Reports tab');
for (const name of ['reportStatus', 'role', 'category', 'verified', 'number']) assert.match(reportFiltersHtml, new RegExp(`name="${name}"`), `the ${name} filter is on the Reports tab`);
assert.match(reportFiltersHtml, /<option(?=[^>]*selected="")(?=[^>]*value="looking")/, 'the report status is read from reportStatus');
assert.match(reportFiltersHtml, /<option(?=[^>]*selected="")(?=[^>]*value="all")/, 'the Inbox status stays its own select');
assert.match(reportFiltersHtml, /<option(?=[^>]*selected="")(?=[^>]*value="worker")/);
assert.match(reportFiltersHtml, /<option(?=[^>]*selected="")(?=[^>]*value="uploads")/);
assert.match(reportFiltersHtml, /<option(?=[^>]*selected="")(?=[^>]*value="yes")/);
assert.match(reportFiltersHtml, /<input(?=[^>]*name="number")(?=[^>]*value="1042")/);
for (const label of ['Report status', 'Role', 'Category', 'Verified', 'Find a number']) assert.ok(textOf(reportFiltersHtml).includes(label), label);
const reportClear = anchors(reportFiltersHtml).find((link) => link.text === 'Clear');
assert.ok(reportClear && reportClear.href === '/inbox?tab=reports', 'Clear keeps the Reports tab only');
const invalidNumberHtml = render(createElement(InboxFilters, { query: { tab: 'reports', status: 'waiting', report: { ...NO_REPORT, numberInput: 'JR-10a2', numberInvalid: true } } }));
assert.match(invalidNumberHtml, /<input(?=[^>]*name="number")(?=[^>]*value="JR-10a2")(?=[^>]*aria-invalid="true")/, 'an invalid number is shown back, marked invalid');
assert.ok(textOf(invalidNumberHtml).includes('Enter a report number such as JR-1042 or 1042.'), 'the invalid number hint');
const bareReportsHtml = render(createElement(InboxFilters, { query: { tab: 'reports', status: 'waiting' } }));
assert.match(bareReportsHtml, /name="role"/, 'the fields show without a parsed report slot');
const supportFiltersHtml = render(createElement(InboxFilters, { query: { tab: 'support', status: 'waiting' } }));
for (const name of ['reportStatus', 'role', 'category', 'verified', 'number']) assert.doesNotMatch(supportFiltersHtml, new RegExp(`name="${name}"`), `no ${name} filter off the Reports tab`);

assert.equal(
  view.inboxListHref({ tab: 'reports', status: 'waiting', report: reportFilterValues, before: 'c2FtcGxl' }),
  '/inbox?tab=reports&reportStatus=looking&role=worker&category=uploads&verified=yes&number=1042&before=c2FtcGxl',
  'paging keeps the report filters on the Reports tab, under reportStatus (never status)',
);
assert.equal(view.inboxListHref({ tab: 'reports', status: 'waiting', report: { ...NO_REPORT, verified: false } }), '/inbox?tab=reports&verified=no');
assert.equal(view.inboxListHref({ tab: 'reports', status: 'waiting', report: { ...NO_REPORT, numberInput: 'jr1042', number: 1042 } }), '/inbox?tab=reports&number=jr1042', 'the number is written as typed');
assert.equal(view.inboxListHref({ tab: 'all', status: 'waiting', report: reportFilterValues }), '/inbox', 'report filters apply on the Reports tab only');
assert.equal(view.inboxEmptyCopy({ tab: 'reports', status: 'waiting', report: reportFilterValues }).filtered, true, 'report filters narrow the list');
assert.equal(view.inboxEmptyCopy({ tab: 'reports', status: 'waiting', report: { ...NO_REPORT, reportStatus: 'new' } }).filtered, true, 'a report status narrows the list');
assert.equal(view.inboxEmptyCopy({ tab: 'reports', status: 'waiting', report: NO_REPORT }).filtered, false);

// The URL FE-1's /reports redirect lands on, through the real K2.3 parser: the
// report status comes from reportStatus, never from the stray Inbox status.
const { load: loadQuery } = compileAdminSources({
  name: 'inbox-view-query',
  sources: ['src/lib/server/admin-inbox.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
  },
});
const { parseInboxQuery } = await loadQuery('src/lib/server/admin-inbox.ts');
const landed = new URL('http://admin.test/inbox?status=new&role=worker&tab=reports&reportStatus=new');
const landedQuery = parseInboxQuery(Object.fromEntries(landed.searchParams));
assert.equal(landedQuery.tab, 'reports', 'the redirect lands on the Reports tab');
assert.equal(landedQuery.report?.reportStatus, 'new', 'reportStatus is the report status');
assert.equal(landedQuery.report?.role, 'worker', 'role carries over');
assert.equal(landedQuery.status, 'waiting', 'the stray status is not an Inbox status (it is not a K2.3 value)');
assert.equal('status' in (landedQuery.report ?? {}), false, 'the report slot has no status key');
assert.equal(view.inboxListHref({ tab: landedQuery.tab, status: landedQuery.status, report: landedQuery.report }), '/inbox?tab=reports&reportStatus=new&role=worker', 'the landed view round-trips through the list links without the stray status');
const landedFilters = render(createElement(InboxFilters, { query: landedQuery }));
assert.match(landedFilters, /<option(?=[^>]*selected="")(?=[^>]*value="new")/, 'the landed filters show the report status selected');

console.log('check-ui-inbox-view: ok');
