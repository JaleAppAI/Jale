// Sprint 28 K2.3: the Inbox query parser and its cursor (lib/server/admin-inbox.ts),
// the part of the contract the Inbox page and the /reports redirect build on.
// Bad values fall back to the defaults; the report filters (with reportStatus,
// its own key) exist only on the reports tab; a cursor is accepted only in the
// exact form the list writes.
import assert from 'node:assert/strict';
import { compileAdminSources } from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'inbox-query',
  sources: ['src/lib/server/admin-inbox.ts', 'src/lib/server/support-conversation.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
  },
});

const inbox = await load('src/lib/server/admin-inbox.ts');
const id = '00000000-0000-4000-8000-000000000010';

// ---- parseInboxQuery ---------------------------------------------------------------
assert.deepEqual(inbox.parseInboxQuery({}), { tab: 'all', status: 'waiting' });
assert.deepEqual(inbox.parseInboxQuery({ tab: 'nope', status: 'open', q: '   ', before: 'junk' }), { tab: 'all', status: 'waiting' });
assert.deepEqual(inbox.parseInboxQuery({ tab: 'support', status: 'resolved', q: '  S-124 ' }), { tab: 'support', status: 'resolved', q: 'S-124' });
assert.deepEqual(inbox.parseInboxQuery({ tab: ['lockouts', 'all'], status: ['all'] }), { tab: 'lockouts', status: 'all' });
assert.equal(inbox.parseInboxQuery({ q: 'x'.repeat(100) }).q.length, 40);

// The report filters only on the reports tab; `status` stays the Inbox status
// and the report status has its own key, reportStatus.
assert.deepEqual(inbox.parseInboxQuery({
  tab: 'reports', status: 'all', reportStatus: 'looking', role: 'employer', category: 'billing', verified: 'no', number: 'JR-1042',
}), {
  tab: 'reports',
  status: 'all',
  report: {
    reportStatus: 'looking', role: 'employer', category: 'billing', verified: false,
    number: 1042, numberInput: 'JR-1042', numberInvalid: false,
  },
});
assert.deepEqual(inbox.parseInboxQuery({ tab: 'reports', status: 'new', reportStatus: 'closed', number: 'JR-10a2' }), {
  tab: 'reports',
  status: 'waiting',
  report: { reportStatus: null, role: null, category: null, verified: null, number: null, numberInput: 'JR-10a2', numberInvalid: true },
});
assert.equal(inbox.parseInboxQuery({ tab: 'all', reportStatus: 'new', role: 'worker' }).report, undefined, 'report filters only on the reports tab');

// ---- The cursor ------------------------------------------------------------------------
const cursor = { sortKey: '2026-10-14T12:00:00.123456Z', source: 'report', id };
const encoded = inbox.encodeInboxCursor(cursor);
assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'base64url');
assert.deepEqual(inbox.decodeInboxCursor(encoded), cursor);
assert.deepEqual(inbox.parseInboxQuery({ before: encoded }), { tab: 'all', status: 'waiting', before: encoded });
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
for (const junk of [
  '', 'junk!', `${encoded}=`, encoded.toUpperCase(), b64('2026-10-14T12:00:00.123456Z|report'),
  b64(`2026-10-14T12:00:00.123Z|report|${id}`),
  b64(`2026-10-14T12:00:00.123456Z|ticket|${id}`),
  b64('2026-10-14T12:00:00.123456Z|case|not-a-uuid'),
  b64(`2026-13-45T12:00:00.123456Z|case|${id}`),
  b64('2026-10-14T12:00:00.123456Z|case|ABCDEF00-0000-4000-8000-00000000000A'),
  b64(`2026-10-14T12:00:00.123456Z|case|${id}|extra`),
  'A'.repeat(300),
]) {
  assert.equal(inbox.decodeInboxCursor(junk), null, `refused: ${junk.slice(0, 40)}`);
  assert.equal(inbox.parseInboxQuery({ before: junk }).before, undefined);
}

console.log('inbox query contract checks passed');
