// Sprint 28 K2.7: the Inbox action policy (lib/action-policy.ts), the request
// parser (lib/action-requests.ts) and the reply counter shared with the reply
// box (lib/support-reply.ts). Pure modules: no database, no session.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminRoot, compileAdminSources, fakeUuid } from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'action-policy',
  sources: ['src/lib/action-policy.ts', 'src/lib/action-requests.ts', 'src/lib/support-reply.ts'],
});

const policy = await load('src/lib/action-policy.ts');
const requests = await load('src/lib/action-requests.ts');
const reply = await load('src/lib/support-reply.ts');

const ids = (actions) => actions.map((action) => action.id);
const byId = (actions) => Object.fromEntries(actions.map((action) => [action.id, action]));

// --- getSupportActions --------------------------------------------------------
{
  const open = policy.getSupportActions({ status: 'open', hasConversation: true }, 'admin_ops');
  assert.deepEqual(ids(open), ['reply', 'request_info', 'resolve', 'reveal_phone']);
  assert.ok(open.every((action) => action.enabled === true && action.reason === undefined), 'an open case with a conversation offers every action to Ops');
  assert.ok(policy.getSupportActions({ status: 'pending_admin', hasConversation: true }, 'admin_superadmin').every((action) => action.enabled));

  // Read-only: every action shown, every one disabled with the K2.7 reason.
  for (const status of ['open', 'pending_worker', 'pending_admin', 'resolved', 'dismissed']) {
    const readonly = policy.getSupportActions({ status, hasConversation: true }, 'admin_readonly');
    assert.deepEqual(ids(readonly), ['reply', 'request_info', 'resolve', 'reveal_phone'], 'actions are never hidden');
    for (const action of readonly) {
      assert.equal(action.enabled, false);
      assert.equal(action.reason, 'Requires Ops or Superadmin.');
    }
  }

  // A closed case takes no message and cannot be resolved again; the number can still be revealed.
  for (const status of ['resolved', 'dismissed']) {
    const closed = byId(policy.getSupportActions({ status, hasConversation: true }, 'admin_ops'));
    for (const id of ['reply', 'request_info', 'resolve']) {
      assert.deepEqual(closed[id], { id, enabled: false, reason: 'This case is closed.' });
    }
    assert.deepEqual(closed.reveal_phone, { id: 'reveal_phone', enabled: true });
  }

  // No conversation: no reply and no number; resolving still works (it sends nothing).
  const noTarget = byId(policy.getSupportActions({ status: 'open', hasConversation: false }, 'admin_ops'));
  assert.deepEqual(noTarget.reply, { id: 'reply', enabled: false, reason: 'This case has no WhatsApp conversation.' });
  assert.deepEqual(noTarget.request_info, { id: 'request_info', enabled: false, reason: 'This case has no WhatsApp conversation.' });
  assert.deepEqual(noTarget.resolve, { id: 'resolve', enabled: true });
  assert.deepEqual(noTarget.reveal_phone, { id: 'reveal_phone', enabled: false, reason: 'This case has no WhatsApp conversation.' });
}

// --- getLockoutActions ----------------------------------------------------------
{
  for (const state of ['locked', 'stuck_at_code']) {
    const actions = policy.getLockoutActions({ state }, 'admin_ops');
    assert.deepEqual(actions, [
      { id: 'reset_lockout', enabled: true },
      { id: 'open_support_from_lockout', enabled: true },
    ]);
  }
  for (const state of ['in_progress', 'verified', 'expired', 'superseded']) {
    const actions = byId(policy.getLockoutActions({ state }, 'admin_superadmin'));
    assert.deepEqual(actions.reset_lockout, { id: 'reset_lockout', enabled: false, reason: 'Only a locked or stuck verification can be reset.' });
    assert.deepEqual(actions.open_support_from_lockout, { id: 'open_support_from_lockout', enabled: true });
  }
  const readonly = policy.getLockoutActions({ state: 'locked' }, 'admin_readonly');
  assert.deepEqual(readonly, [
    { id: 'reset_lockout', enabled: false, reason: 'Requires Ops or Superadmin.' },
    { id: 'open_support_from_lockout', enabled: false, reason: 'Requires Ops or Superadmin.' },
  ]);
  assert.equal(policy.canActOnInbox('admin_ops'), true);
  assert.equal(policy.canActOnInbox('admin_superadmin'), true);
  assert.equal(policy.canActOnInbox('admin_readonly'), false);
}

// The retired case console's policy is gone with its dispatcher.
assert.equal(policy.getCaseActions, undefined);
assert.equal(requests.parseAdminActionRequest, undefined);
assert.equal(requests.validateAdminAction, undefined);

// --- parseInboxAction (K2.7 bodies) ---------------------------------------------
{
  const requestId = fakeUuid(0x101);
  const caseId = fakeUuid(0x102);
  const challengeId = fakeUuid(0x103);
  const mediaId = fakeUuid(0x104);
  const parse = (body) => requests.parseInboxAction(body);
  const invalid = { ok: false };

  assert.deepEqual(parse({ action: 'reply', requestId, caseId, text: '  Hola, ya revisamos tu cuenta.  ' }), {
    ok: true,
    value: { action: 'reply', requestId, caseId, text: 'Hola, ya revisamos tu cuenta.' },
  });
  assert.deepEqual(parse({ action: 'request_info', requestId, caseId: caseId.toUpperCase(), text: 'Send a photo, please.' }), {
    ok: true,
    value: { action: 'request_info', requestId, caseId, text: 'Send a photo, please.' },
  });
  assert.deepEqual(parse({ action: 'reply', requestId, caseId, text: 'x'.repeat(1000) }).ok, true);
  assert.deepEqual(parse({ action: 'reply', requestId, caseId, text: 'x'.repeat(1001) }), invalid);
  assert.deepEqual(parse({ action: 'reply', requestId, caseId, text: '   ' }), invalid);
  assert.deepEqual(parse({ action: 'reply', requestId, caseId }), invalid);
  assert.deepEqual(parse({ action: 'reply', requestId, caseId, text: 'a\u0000b' }), invalid);
  assert.deepEqual(parse({ action: 'resolve', requestId, caseId }), { ok: true, value: { action: 'resolve', requestId, caseId } });

  // The reveal reason: the existing rule, 20 to 500 characters.
  assert.deepEqual(parse({ action: 'reveal_phone', requestId, caseId, justification: 'Calling the worker back about the lockout.' }), {
    ok: true,
    value: { action: 'reveal_phone', requestId, caseId, justification: 'Calling the worker back about the lockout.' },
  });
  assert.deepEqual(parse({ action: 'reveal_phone', requestId, caseId, justification: 'too short' }), invalid);
  assert.deepEqual(parse({ action: 'reveal_phone', requestId, caseId, justification: 'y'.repeat(501) }), invalid);

  assert.deepEqual(parse({ action: 'open_media', requestId, caseId, mediaId }), {
    ok: true,
    value: { action: 'open_media', requestId, caseId, mediaId },
  });
  assert.deepEqual(parse({ action: 'open_media', requestId, caseId, mediaId: 'support/key.jpg' }), invalid);

  assert.deepEqual(parse({ action: 'reset_lockout', requestId, challengeId, reasonCode: 'codes_not_arriving' }), {
    ok: true,
    value: { action: 'reset_lockout', requestId, challengeId, reasonCode: 'codes_not_arriving' },
  });
  assert.deepEqual(parse({ action: 'reset_lockout', requestId, challengeId, reasonCode: 'worker_confused', note: '  ' }), {
    ok: true,
    value: { action: 'reset_lockout', requestId, challengeId, reasonCode: 'worker_confused' },
  });
  assert.deepEqual(parse({ action: 'reset_lockout', requestId, challengeId, reasonCode: 'other', note: 'Spoke on the phone.' }), {
    ok: true,
    value: { action: 'reset_lockout', requestId, challengeId, reasonCode: 'other', note: 'Spoke on the phone.' },
  });
  assert.deepEqual(parse({ action: 'reset_lockout', requestId, challengeId, reasonCode: 'other' }), invalid, 'other needs a note');
  assert.deepEqual(parse({ action: 'reset_lockout', requestId, challengeId, reasonCode: 'other', note: 'n'.repeat(301) }), invalid);
  assert.deepEqual(parse({ action: 'reset_lockout', requestId, challengeId, reasonCode: 'because' }), invalid);
  assert.deepEqual(parse({ action: 'open_support_from_lockout', requestId, challengeId }), {
    ok: true,
    value: { action: 'open_support_from_lockout', requestId, challengeId },
  });

  // Every action needs a UUID request id; unknown actions and old ones are refused.
  assert.deepEqual(parse({ action: 'resolve', requestId: 'req-1', caseId }), invalid);
  assert.deepEqual(parse({ action: 'resolve', caseId }), invalid);
  assert.deepEqual(parse({ action: 'reply_whatsapp', requestId, caseId, text: 'x' }), invalid);
  assert.deepEqual(parse({ action: 'resolve', requestId, caseId: 'case_hel_1001' }), invalid);
  assert.deepEqual(parse(null), invalid);
  assert.deepEqual(parse([]), invalid);
  assert.deepEqual([...requests.INBOX_ACTIONS], [
    'reply', 'request_info', 'resolve', 'reveal_phone', 'open_media', 'reset_lockout', 'open_support_from_lockout',
  ]);
}

// --- The reply counter (CCR-7) ----------------------------------------------------
{
  assert.equal(reply.TEMPLATE_REPLY_MAX_CHARS, 250);
  assert.equal(reply.FREEFORM_REPLY_MAX_CHARS, 1000);
  assert.equal(reply.templateReplyText('  Hola\n\n  mundo\t !  '), 'Hola mundo !');
  assert.equal(reply.templateReplyLength('  Hola\n\n  mundo\t !  '), 12);
  // UTF-16 code units: an emoji outside the BMP counts twice, as the database counts it.
  assert.equal(reply.templateReplyLength('\u{1F600}'), 2);
  // Every JavaScript whitespace character folds, including no-break and ideographic spaces.
  assert.equal(reply.templateReplyText('a  　﻿b'), 'a b');
  const source = readFileSync(resolve(adminRoot, 'src/lib/support-reply.ts'), 'utf8');
  assert.doesNotMatch(source, /^import /m, 'support-reply.ts is client-safe: it imports nothing');
}

console.log('inbox action policy checks passed');
