// Test-only support conversations shaped like K2.4
// (src/lib/server/support-conversation.ts) and K2.7 CaseAction lists.
// Synthetic values only. Never imported by src.
import { fid } from './fe2-inbox.mjs';

export const CASE_OPEN = fid(0xc1);
export const CASE_CLOSED = fid(0xc5);
export const CASE_FROM_LOCKOUT = fid(0xc6);

/** K2.7: the reason every action carries for admin_readonly. */
export const READONLY_REASON = 'Requires Ops or Superadmin.';

export const OPS_ACTIONS = [
  { id: 'reply', enabled: true },
  { id: 'request_info', enabled: true },
  { id: 'resolve', enabled: true },
  { id: 'reveal_phone', enabled: true },
];
export const READONLY_ACTIONS = OPS_ACTIONS.map((action) => ({ id: action.id, enabled: false, reason: READONLY_REASON }));

// The approved template text around {{1}} (LUIS-DECISIONS D-W7; keys
// admin_support_reply_v2_es/en, K2.8). The quote marks belong to the template,
// so they are part of before/after.
export const TEMPLATE_ES = { before: 'Jale Soporte: «', after: '». Responde a este mensaje si necesitas más ayuda.' };
export const TEMPLATE_EN = { before: 'Jale Support replied to your help request: “', after: '”. Reply to this message if you need more help.' };

const REGISTERED_WORKER = {
  label: 'Worker #1042',
  registered: true,
  userId: '00000000-0000-4000-8000-0000000000a1',
  onboardingStepLabel: 'Identity check',
  onboardingStepIndex: 5,
  onboardingStepCount: 8,
  failedCodesToday: 2,
  joinedAt: '2026-09-30T16:00:00.000Z',
};

/** Window open (the worker wrote at 11:48, so it closes in 20h 48m at NOW_ISO); freeform replies. */
export const OPEN_CONVERSATION = {
  caseId: CASE_OPEN,
  ref: 'S-124',
  kind: 'support',
  typeLabel: 'Support',
  status: 'pending_admin',
  statusLabel: 'Waiting on admin',
  subject: 'No me llega el código de verificación',
  language: 'es',
  languageLabel: 'Spanish',
  messages: [
    { id: fid(0xe1), at: '2026-10-14T10:02:00.000Z', from: 'system', kind: 'note', text: 'Worker sent SOPORTE and entered support mode' },
    { id: fid(0xe2), at: '2026-10-14T10:03:00.000Z', from: 'worker', kind: 'text', text: 'Hola, no me llega el código de verificación cuando intento entrar en la web' },
    { id: fid(0xe3), at: '2026-10-14T10:04:00.000Z', from: 'worker', kind: 'media', mediaId: fid(0xf1), mediaType: 'image', caption: null, expired: false },
    { id: fid(0xe4), at: '2026-10-14T10:04:30.000Z', from: 'worker', kind: 'media', mediaId: fid(0xf2), mediaType: 'audio', caption: null, expired: true },
    { id: fid(0xe5), at: '2026-10-14T10:05:00.000Z', from: 'system', kind: 'note', text: 'Admins notified by email' },
    { id: fid(0xe6), at: '2026-10-14T11:00:00.000Z', from: 'admin', kind: 'text', text: 'Hola, ya revisamos tu cuenta.\nPrueba de nuevo ahora.', byRole: 'Ops', delivery: 'delivered', via: 'freeform' },
    { id: fid(0xe7), at: '2026-10-14T11:48:00.000Z', from: 'worker', kind: 'text', text: 'Ya lo intenté 3 veces' },
  ],
  window: { open: true, closesAt: '2026-10-15T11:48:00.000Z', closedAt: null },
  reply: { mode: 'freeform', maxChars: 1000, templatePreview: null },
  worker: REGISTERED_WORKER,
  facts: { openedAt: '2026-10-14T10:02:00.000Z', waitingSince: '2026-10-14T11:48:00.000Z', messageCount: 3, mediaCount: 2, adminsEmailed: 2 },
  earlierCases: [{ caseId: fid(0xc0), ref: 'S-97', statusLabel: 'Resolved', closedAt: '2026-09-30T12:00:00.000Z' }],
  actions: OPS_ACTIONS,
};

/** Window closed 2h before NOW_ISO; replies ride the Spanish template. */
export const CLOSED_CONVERSATION = {
  ...OPEN_CONVERSATION,
  caseId: CASE_CLOSED,
  ref: 'S-128',
  status: 'pending_worker',
  statusLabel: 'Waiting on worker',
  messages: [
    { id: fid(0xe8), at: '2026-10-13T13:00:00.000Z', from: 'worker', kind: 'text', text: 'Gracias, lo intento mañana' },
    { id: fid(0xe9), at: '2026-10-13T14:00:00.000Z', from: 'admin', kind: 'text', text: 'Avísanos si sigue fallando.', byRole: 'Superadmin', delivery: 'sent', via: 'template' },
    { id: fid(0xea), at: '2026-10-14T14:10:00.000Z', from: 'admin', kind: 'text', text: '¿Pudiste entrar?', byRole: 'Ops', delivery: 'waiting_for_window', via: null },
  ],
  window: { open: false, closesAt: null, closedAt: '2026-10-14T13:00:00.000Z' },
  reply: { mode: 'template', maxChars: 250, templatePreview: TEMPLATE_ES },
  facts: { ...OPEN_CONVERSATION.facts, waitingSince: '2026-10-14T14:10:00.000Z' },
};

/** Opened from a lockout: no worker message yet, unregistered, English, no window history. */
export const FROM_LOCKOUT_CONVERSATION = {
  ...OPEN_CONVERSATION,
  caseId: CASE_FROM_LOCKOUT,
  ref: 'S-129',
  status: 'open',
  statusLabel: 'Open',
  subject: 'Locked out of verification',
  language: 'en',
  languageLabel: 'English',
  messages: [
    { id: fid(0xeb), at: '2026-10-14T14:50:00.000Z', from: 'system', kind: 'note', text: 'Opened from lockout V-1A2B3C4D' },
  ],
  window: { open: false, closesAt: null, closedAt: null },
  reply: { mode: 'template', maxChars: 250, templatePreview: TEMPLATE_EN },
  worker: { label: 'Unregistered number', registered: false, userId: null, onboardingStepLabel: null, onboardingStepIndex: null, onboardingStepCount: null, failedCodesToday: null, joinedAt: null },
  facts: { openedAt: '2026-10-14T14:50:00.000Z', waitingSince: null, messageCount: 0, mediaCount: 0, adminsEmailed: 0 },
  earlierCases: [],
};
