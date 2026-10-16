// Sprint 28 contract K2.6: the reasons an admin picks when resetting a
// lockout, with the labels the reset form shows. Client-safe on purpose: no
// server imports, so a client component can import it without pulling the
// database or audit modules into the browser bundle. Re-exported from
// lib/server/admin-lockouts.ts, the K2.6 import path.
export type LockoutResetReason = 'codes_not_arriving' | 'worker_confused' | 'typo_in_details' | 'identity_confirmed_elsewhere' | 'other';

export const LOCKOUT_RESET_REASONS: ReadonlyArray<{ code: LockoutResetReason; label: string }> = [
  { code: 'codes_not_arriving', label: 'Codes not arriving' },
  { code: 'worker_confused', label: 'Worker confused by the steps' },
  { code: 'typo_in_details', label: 'Typo in their details' },
  { code: 'identity_confirmed_elsewhere', label: 'Confirmed identity another way' },
  { code: 'other', label: 'Other (add a note)' },
];
