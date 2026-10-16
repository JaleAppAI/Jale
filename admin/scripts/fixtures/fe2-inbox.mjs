// Test-only Inbox rows shaped like K2.3 (src/lib/server/admin-inbox.ts).
// Synthetic values only. Never imported by src.

/** A fixed, obviously synthetic UUID. */
export const fid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** "Now" for every fixture time, so relative times and waits are exact. */
export const NOW_ISO = '2026-10-14T15:00:00.000Z';

/** One row per kind, oldest wait first, as loadInbox returns the 'waiting' filter. */
export const INBOX_ITEMS = [
  { kind: 'report', id: fid(0xa1), ref: 'JR-88', typeLabel: 'Problem report', subject: 'Upload keeps spinning on my ID photo', from: 'Worker (web)', statusLabel: 'New', waitingOn: 'us', waitingSince: '2026-10-13T10:48:00.000Z', unread: true, href: `/inbox/reports/${fid(0xa1)}` },
  { kind: 'support', id: fid(0xc1), ref: 'S-124', typeLabel: 'Support', subject: 'No me llega el código de verificación', from: 'Worker', statusLabel: 'Waiting on admin', waitingOn: 'us', waitingSince: '2026-10-14T11:48:00.000Z', unread: true, href: `/inbox/support/${fid(0xc1)}` },
  { kind: 'delivery_issue', id: fid(0xc2), ref: 'S-125', typeLabel: 'Delivery issue', subject: 'A reply could not be delivered', from: 'Worker', statusLabel: 'Open', waitingOn: 'us', waitingSince: '2026-10-14T12:30:00.000Z', unread: true, href: `/inbox/support/${fid(0xc2)}` },
  { kind: 'stuck_conversation', id: fid(0xc3), ref: 'S-126', typeLabel: 'Stuck conversation', subject: 'Onboarding stopped at the trade step after the worker sent three voice notes and a photo of a document that could not be read at all', from: 'Unregistered number', statusLabel: 'Open', waitingOn: 'us', waitingSince: '2026-10-14T13:05:00.000Z', unread: true, href: `/inbox/support/${fid(0xc3)}` },
  { kind: 'lockout', id: fid(0xb1), ref: 'V-1A2B3C4D', typeLabel: 'Lockout', subject: 'Locked out of verification', from: 'Worker', statusLabel: 'Locked', waitingOn: 'us', waitingSince: '2026-10-14T14:35:00.000Z', unread: true, href: `/inbox/lockouts/${fid(0xb1)}` },
  { kind: 'support', id: fid(0xc7), ref: 'S-122', typeLabel: 'Support', subject: '¿Cómo cambio mi ciudad?', from: 'Worker', statusLabel: 'Waiting on worker', waitingOn: 'worker', waitingSince: '2026-10-14T10:00:00.000Z', unread: false, href: `/inbox/support/${fid(0xc7)}` },
  { kind: 'verification_blocker', id: fid(0xc4), ref: 'S-127', typeLabel: 'Verification', subject: 'Verification reset', from: 'Worker', statusLabel: 'Resolved', waitingOn: 'nobody', waitingSince: null, unread: false, href: `/inbox/support/${fid(0xc4)}` },
];
