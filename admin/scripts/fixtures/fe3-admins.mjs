// Test-only data for the Admins checks and the FE-3 gallery. Never imported by
// src. Ids are synthetic; emails use the reserved example.test domain.
export const NOW_ISO = '2026-10-14T12:00:00.000Z';

export const IDS = {
  self: '00000000-0000-4000-8000-0000000000b1',
  ops: '00000000-0000-4000-8000-0000000000b2',
  invited: '00000000-0000-4000-8000-0000000000b3',
  reader: '00000000-0000-4000-8000-0000000000b4',
};

// The loader's order: active first, then invited, then deactivated.
export const ADMINS = [
  {
    id: IDS.self, email: 'admin-a@example.test', role: 'admin_superadmin', status: 'active',
    lastSignInAt: '2026-10-14T11:58:00.000Z', trustedBrowsers: 1, createdAt: '2026-01-05T10:00:00.000Z',
    isSelf: true, canResendInvite: false,
  },
  {
    id: IDS.ops, email: 'admin-b@example.test', role: 'admin_ops', status: 'active',
    lastSignInAt: '2026-10-14T10:00:00.000Z', trustedBrowsers: 2, createdAt: '2026-03-01T10:00:00.000Z',
    isSelf: false, canResendInvite: false,
  },
  {
    id: IDS.invited, email: 'admin-d.with-a-long-address-to-wrap@example.test', role: 'admin_ops', status: 'invited',
    lastSignInAt: null, trustedBrowsers: 0, createdAt: '2026-10-13T09:00:00.000Z',
    isSelf: false, canResendInvite: true,
  },
  {
    id: IDS.reader, email: 'admin-c@example.test', role: 'admin_readonly', status: 'deactivated',
    lastSignInAt: '2026-10-11T09:00:00.000Z', trustedBrowsers: 0, createdAt: '2026-02-01T10:00:00.000Z',
    isSelf: false, canResendInvite: false,
  },
];

export const admin = (key) => ADMINS.find((item) => item.id === IDS[key]);
export const OK_RESULT = { status: 'ok', viewerId: IDS.self, admins: ADMINS };
export const FORBIDDEN_RESULT = { status: 'forbidden' };

/** adminFetchJson answers, by shape. */
export const okAnswer = (item) => ({ kind: 'ok', status: 200, data: { ok: true, admin: item } });
export const errorAnswer = (status, error, saved) => ({
  kind: 'error',
  status,
  data: saved === undefined ? { ok: false, error } : { ok: false, error, saved },
});
