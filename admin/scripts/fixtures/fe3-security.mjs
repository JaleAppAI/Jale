// Test-only data for the Security checks and the FE-3 gallery. Never imported
// by src. Ids are synthetic; emails use the reserved example.test domain.
export const WORKER = '00000000-0000-4000-8000-0000000000a1';
export const ADMIN = '00000000-0000-4000-8000-0000000000d1';
export const ADMIN_TWO = '00000000-0000-4000-8000-0000000000d2';
export const OTHER_ACTOR = '00000000-0000-4000-8000-0000000000f1';
export const CASE = '00000000-0000-4000-8000-0000000000c1';
export const REQUEST = '11111111-2222-4333-8444-555555555555';
/** The server render's time in the Security checks. */
export const NOW_ISO = '2026-10-14T12:00:30.000Z';

export const ADMIN_OPTIONS = [
  { id: ADMIN, email: 'ops-admin@example.test' },
  { id: ADMIN_TWO, email: 'readonly-admin@example.test' },
];

export const REVEAL_ENTRY = {
  key: 'event:00000000-0000-4000-8000-0000000000e1', source: 'event', occurredAt: '2026-10-01T12:00:00.123Z',
  kind: 'read', outcome: 'allowed', actorKind: 'admin', actorId: ADMIN, actorRole: 'admin_ops',
  actorEmail: 'ops-admin@example.test', channel: 'admin', surface: 'admin.case_detail.reveal',
  categories: ['contact_details'], subjectUserIds: [WORKER], recordType: 'admin_case', recordIds: [CASE],
  resultCount: 1, fieldNames: ['full_name', 'phone'], purposeKind: 'reveal', reason: 'Synthetic callback reason.',
  changedFields: [], piiReveal: false, requestId: REQUEST,
};
export const DENIED_ENTRY = {
  key: 'event:00000000-0000-4000-8000-0000000000e4', source: 'event', occurredAt: '2026-10-01T11:30:00.000Z',
  kind: 'attempt', outcome: 'denied', actorKind: 'admin', actorId: ADMIN, actorRole: 'admin_readonly',
  actorEmail: 'readonly-admin@example.test', channel: 'admin', surface: 'admin.access_history',
  categories: ['audit_history'], subjectUserIds: [], recordIds: [], resultCount: 0, fieldNames: [],
  purposeKind: 'audit_review', changedFields: [], piiReveal: false,
};
export const CHANGE_ENTRY = {
  key: 'change:00000000-0000-4000-8000-0000000000e2', source: 'change', occurredAt: '2026-10-01T11:00:00.000Z',
  actorKind: 'admin', actorId: ADMIN, actorEmail: 'ops-admin@example.test', channel: 'admin',
  surface: 'admin.case_detail.resolve_case', categories: [], subjectUserIds: [WORKER], recordIds: [CASE],
  fieldNames: [], tableName: 'public.admin_cases', operation: 'update', rowCount: 1,
  changedFields: ['status', 'resolved_at'], contextStatus: 'ok', piiReveal: false,
};
export const LEGACY_ENTRY = {
  key: 'legacy:00000000-0000-4000-8000-0000000000e3', source: 'legacy', occurredAt: '2026-09-01T09:00:00.000Z',
  actorKind: 'admin', actorRole: 'admin_ops', actorEmail: 'ops-admin@example.test', categories: [],
  subjectUserIds: [], recordIds: [], fieldNames: [], reason: 'Called [removed] about the case.', changedFields: [],
  action: 'reveal_pii', targetType: 'admin_case', targetId: CASE,
  summary: 'admin_ops requested reveal_pii for admin_case.', piiReveal: true,
};
export const SIGN_IN_ENTRY = {
  key: 'event:00000000-0000-4000-8000-0000000000e5', source: 'event', occurredAt: '2026-10-01T13:00:00.000Z',
  kind: 'session', outcome: 'signed_in', actorKind: 'admin', actorId: ADMIN, actorRole: 'admin_ops',
  actorEmail: 'ops-admin@example.test', channel: 'admin', surface: 'admin.session', categories: ['admin_access'],
  subjectUserIds: [], recordIds: [], resultCount: 0, fieldNames: ['trusted_device'], changedFields: [], piiReveal: false,
};
export const ENTRIES = [REVEAL_ENTRY, DENIED_ENTRY, CHANGE_ENTRY, LEGACY_ENTRY];
