// Checks the problem-report policy (src/lib/report-policy.ts): who may do
// what in the Reports inbox, for every role and capability, and the closed
// code lists the inbox shares with the database.
import assert from 'node:assert/strict';
import { compileAdminSources } from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'report-policy',
  sources: ['src/lib/report-policy.ts'],
});

const policy = await load('src/lib/report-policy.ts');

const ROLES = ['admin_readonly', 'admin_ops', 'admin_superadmin'];
const CAPABILITIES = [
  'view_list',
  'view_detail',
  'view_settings',
  'reveal_contact',
  'view_screenshot',
  'set_status',
  'set_note',
  'update_settings',
];

// --- Role x capability -------------------------------------------------------
// Read-only admins get the list and the detail only. Contact reveals and
// screenshot links are for the roles that may change reports. The
// settings are for superadmins.
const EXPECTED = {
  admin_readonly: ['view_list', 'view_detail'],
  admin_ops: ['view_list', 'view_detail', 'reveal_contact', 'view_screenshot', 'set_status', 'set_note'],
  admin_superadmin: [
    'view_list',
    'view_detail',
    'view_settings',
    'reveal_contact',
    'view_screenshot',
    'set_status',
    'set_note',
    'update_settings',
  ],
};

assert.deepEqual([...policy.REPORT_CAPABILITIES], CAPABILITIES, 'the capability list is closed and ordered');

for (const role of ROLES) {
  for (const capability of CAPABILITIES) {
    assert.equal(
      policy.canReport(role, capability),
      EXPECTED[role].includes(capability),
      `${role} x ${capability}`,
    );
  }
  assert.deepEqual(policy.reportCapabilities(role), EXPECTED[role], `${role} capabilities`);
}

// Anything outside the closed lists is refused, never thrown on.
for (const [role, capability] of [
  ['admin_unknown', 'view_list'],
  ['', 'view_detail'],
  [undefined, 'view_list'],
  ['admin_superadmin', 'delete_report'],
  ['admin_superadmin', 'reveal_pii'],
  ['admin_superadmin', '__proto__'],
  ['admin_superadmin', 'toString'],
  ['admin_superadmin', undefined],
]) {
  assert.equal(policy.canReport(role, capability), false, `${String(role)} x ${String(capability)} is refused`);
}
assert.deepEqual(policy.reportCapabilities('admin_unknown'), []);

// --- The five actions: their own vocabulary, not the case console's ----------
assert.deepEqual(
  [...policy.REPORT_ACTION_IDS],
  ['reveal_contact', 'view_screenshot', 'set_status', 'set_note', 'update_settings'],
);
for (const actionId of policy.REPORT_ACTION_IDS) {
  assert.equal(policy.isReportActionId(actionId), true, `${actionId} is an action`);
}
for (const value of ['reveal_pii', 'resolve_case', 'view_list', 'view_settings', 'delete', '', 'toString', '__proto__', null, undefined, 1, {}]) {
  assert.equal(policy.isReportActionId(value), false, `${JSON.stringify(value) ?? String(value)} is not an action`);
}

// --- Code lists, mirrored from the report tables' CHECK constraints ----------
assert.deepEqual([...policy.REPORT_STATUSES], ['new', 'looking', 'fixed', 'wont_fix']);
assert.deepEqual([...policy.REPORT_ROLES], ['worker', 'employer', 'unknown']);
assert.deepEqual(
  [...policy.WORKER_REPORT_CATEGORIES],
  ['sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other'],
);
assert.deepEqual(
  [...policy.EMPLOYER_REPORT_CATEGORIES],
  ['account', 'job_posting', 'applicants', 'messages', 'billing', 'emails', 'company_profile', 'other'],
);
assert.deepEqual(
  [...policy.REPORT_CATEGORIES],
  [
    'sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp',
    'account', 'job_posting', 'applicants', 'messages', 'billing', 'emails', 'company_profile',
    'other',
  ],
  'every category once, in the table CHECK order',
);

for (const status of policy.REPORT_STATUSES) {
  assert.equal(typeof policy.REPORT_STATUS_LABELS[status], 'string', `${status} has a label`);
  assert.equal(policy.isReportStatus(status), true);
}
assert.equal(policy.REPORT_STATUS_LABELS.wont_fix, "Won't fix");
for (const role of policy.REPORT_ROLES) {
  assert.equal(typeof policy.REPORT_ROLE_LABELS[role], 'string', `${role} has a label`);
  assert.equal(policy.isReportRole(role), true);
}
for (const category of policy.REPORT_CATEGORIES) {
  assert.equal(typeof policy.REPORT_CATEGORY_LABELS[category], 'string', `${category} has a label`);
  assert.equal(policy.isReportCategory(category), true);
}
assert.equal(policy.REPORT_CATEGORY_LABELS.applying, 'Applying to a job');
assert.equal(policy.REPORT_CATEGORY_LABELS.applicants, 'Applicants and hiring');
for (const value of ['', 'New', 'closed', 'toString', '__proto__', null, undefined]) {
  assert.equal(policy.isReportStatus(value), false);
  assert.equal(policy.isReportRole(value), false);
  assert.equal(policy.isReportCategory(value), false);
}

// --- Report numbers and ids --------------------------------------------------
assert.equal(policy.formatReportNumber(1042), 'JR-1042');
for (const [input, expected] of [
  ['JR-1042', 1042],
  ['1042', 1042],
  ['  jr-1042 ', 1042],
  ['JR1042', 1042],
  ['000123', 123],
  ['JR-', null],
  ['', null],
  ['   ', null],
  ['JR-10a2', null],
  ['-1042', null],
  ['10.42', null],
  ['1e3', null],
  ['JR-0', null],
  ['9'.repeat(16), null],
  [undefined, null],
]) {
  assert.equal(policy.parseReportNumber(input), expected, `parseReportNumber(${JSON.stringify(input)})`);
}

assert.equal(policy.isReportId('00000000-0000-4000-8000-0000000000aa'), true);
assert.equal(policy.isReportId('00000000-0000-4000-8000-0000000000AA'), true);
for (const value of ['', 'JR-1042', '00000000-0000-4000-8000-0000000000a', '../00000000-0000-4000-8000-0000000000aa', null, 7]) {
  assert.equal(policy.isReportId(value), false, `${String(value)} is not a report id`);
}

// --- Limits shared by the forms and the route --------------------------------
assert.equal(policy.REVEAL_REASON_MIN_LENGTH, 20, 'the existing reveal rule: at least 20 characters');
assert.equal(policy.REVEAL_REASON_MAX_LENGTH, 500, 'the audit reason limit');
assert.equal(policy.REPORT_NOTE_MAX_LENGTH, 4000);
assert.equal(policy.SIGNED_OUT_DAILY_CAP_MAX, 5000);

console.log('admin report policy checks passed');
