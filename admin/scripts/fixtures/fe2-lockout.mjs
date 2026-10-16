// Test-only lockout detail shaped like K2.6 (src/lib/server/admin-lockouts.ts).
// Synthetic values only. Never imported by src.
import { READONLY_REASON } from './fe2-conversation.mjs';
import { fid } from './fe2-inbox.mjs';

// The labels equal LOCKOUT_RESET_REASONS in src/lib/lockout-reasons.ts on
// b75431f2 (plan C2-5); Task 10 asserts the two stay equal.
export const LOCKOUT_REASONS = [
  { code: 'codes_not_arriving', label: 'Codes not arriving' },
  { code: 'worker_confused', label: 'Worker confused by the steps' },
  { code: 'typo_in_details', label: 'Typo in their details' },
  { code: 'identity_confirmed_elsewhere', label: 'Confirmed identity another way' },
  { code: 'other', label: 'Other (add a note)' },
];

export const OPS_LOCKOUT_ACTIONS = [
  { id: 'reset_lockout', enabled: true },
  { id: 'open_support_from_lockout', enabled: true },
];
export const READONLY_LOCKOUT_ACTIONS = OPS_LOCKOUT_ACTIONS.map((action) => ({ id: action.id, enabled: false, reason: READONLY_REASON }));

export const LOCKED_DETAIL = {
  challengeId: fid(0xb1),
  ref: 'V-1A2B3C4D',
  state: 'locked',
  statusLabel: 'Locked',
  languageLabel: 'Spanish',
  maskedPhone: '•••• ••77',
  attemptsUsed: 3,
  attemptsAllowed: 3,
  startedAt: '2026-10-12T12:00:00.000Z',
  lockedUntil: '2026-10-14T16:07:00.000Z',
  earlierResets: 1,
  typicalMinutesToVerify: 41,
  timeline: [
    { at: '2026-10-12T12:00:00.000Z', title: 'Started identity verification', detail: 'From onboarding step 5' },
    { at: '2026-10-14T09:41:00.000Z', title: 'Attempt 1 failed', detail: 'Code entered incorrectly' },
    { at: '2026-10-14T09:52:00.000Z', title: 'Attempt 2 failed', detail: 'Code expired before it was entered' },
    { at: '2026-10-14T10:07:00.000Z', title: 'Attempt 3 failed · locked', detail: 'Code entered incorrectly' },
    { at: '2026-10-14T10:07:30.000Z', title: 'Lockout added to the Inbox', detail: null },
  ],
  supportCaseId: null,
  actions: OPS_LOCKOUT_ACTIONS,
};

/** No median yet, no earlier resets, no timeline, already verified. */
export const NO_HISTORY_DETAIL = {
  ...LOCKED_DETAIL,
  state: 'verified',
  statusLabel: 'Verified',
  typicalMinutesToVerify: null,
  earlierResets: 0,
  timeline: [],
};
