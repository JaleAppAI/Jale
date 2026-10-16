// Admin UI contract: the case server side (BE-2b).
// admin-cases.ts (the dashboard loader) and admin-audit.ts; the Inbox
// actions replaced the case console's dispatch in sprint 28 (K2.7), and the
// number of a case never passes through the console's own SQL.
// Split out of check-ui-contract.mjs in sprint 28 step 0.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { read, root } from './lib/ui-contract-helpers.mjs';

const casesModule = read('src/lib/server/admin-cases.ts');

// The dashboard's tiles keep their own queries, now inside the one recorded
// read transaction; the reveal tile reads the access
// records through jale_audit.reveal_count, not admin_audit_log.
for (const call of [
  'countOpenCasesByWait(client)',
  'listOpenAdminCaseRows(client, DASHBOARD_PREVIEW_SIZE)',
  'countRecentReveals(client, REVEAL_TILE_DAYS)',
  'listIdentityLockouts(client)',
]) {
  assert.ok(casesModule.includes(call), `the dashboard loader must call ${call}`);
}
assert.doesNotMatch(read('src/lib/server/admin-audit.ts'), /FROM admin_audit_log WHERE pii_reveal/, 'the reveal tile no longer counts admin_audit_log rows');
assert.equal(
  existsSync(resolve(root, 'src/lib/server/admin-verifications.ts')),
  false,
  'the verification-queue read model was retired (roadmap 1b)',
);

// Sprint 28 (K2.7): the case console's dispatch, its route and its audit
// preview are gone; POST /api/inbox-actions replaces them.
for (const path of [
  'src/lib/audit-contract.ts',
  'src/lib/server/admin-action-dispatch.ts',
  'src/app/api/admin-actions/route.ts',
]) {
  assert.equal(existsSync(resolve(root, path)), false, `${path} was retired with the case console`);
}
const inboxRoute = read('src/app/api/inbox-actions/route.ts');
assert.match(inboxRoute, /return handleInboxActionRequest\(request, state\.session\);/, 'the Inbox route delegates to the actions module');
// The number stays in SQL: the actions call definers and never read or
// write the conversation's number or the outbox themselves.
const inboxActions = read('src/lib/server/inbox-actions.ts');
assert.doesNotMatch(inboxActions, /whatsapp_number|whatsapp_conversations|INSERT\s+INTO|UPDATE\s+admin_cases/i);
for (const definer of [
  'admin_queue_support_message',
  'admin_support_reveal_phone',
  'admin_support_media_link',
  'admin_reset_identity_lockout',
  'admin_open_support_from_lockout',
]) {
  assert.ok(inboxActions.includes(`public.${definer}(`), `inbox-actions.ts calls ${definer}`);
}

// --- Roadmap 2d: Home reads the by-wait counts on the loader's client --------
assert.match(
  casesModule,
  /const openByWait = await countOpenCasesByWait\(client\);/,
  'the dashboard loader reads the by-wait counts on its transaction client',
);

console.log('admin UI case server contract checks passed');
