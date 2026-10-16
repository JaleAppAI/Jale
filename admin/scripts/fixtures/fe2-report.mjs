// Manual-pass data shaped like ProblemReportDetail and ReportSettingsView
// (src/lib/server/admin-reports.ts). Synthetic values only. Never imported by src in a commit.
import { fid } from './fe2-inbox.mjs';

export const REPORT_DETAIL = {
  id: fid(0xa1), number: 88, numberLabel: 'JR-88', role: 'worker', roleLabel: 'Worker', verified: true,
  category: 'uploads', categoryLabel: 'Uploads', stopsWork: true, locale: 'es', includeTechnical: true,
  status: 'new', statusLabel: 'New', hasImage: true, imageAvailable: true,
  createdAt: '2026-10-13T10:48:00.000Z', updatedAt: '2026-10-13T10:48:00.000Z', statusChangedAt: null,
  contentErased: false,
  description: "I pick my ID photo, the bar starts, and it just keeps spinning. I waited 5 minutes and tried twice. I'm on my phone.",
  context: {
    screen: { pattern: '/worker/profile/documents', refs: [] },
    screens: ['/worker/profile', '/worker/profile/documents'],
    app: { build: 'synthetic-build', locale: 'es', theme: 'light' },
    device: { kind: 'phone', browser: 'Chrome', os: 'Android', viewport: [390, 844], online: true, tz: 'America/Chicago', localTime: '05:48' },
    requests: [{ method: 'POST', pattern: '/api/worker/documents', status: 504, ms: 30012, requestId: fid(0x51) }],
    errors: [{ kind: 'api', message: 'Upload timed out', at: '2026-10-13T10:47:30.000Z' }],
    capture: { outcome: 'ok', ms: 420 },
  },
  internalNote: null, contactKind: 'typed', contactMasked: '•••• ••42', accountUserId: null, accountExists: true,
};

export const REPORT_SETTINGS = {
  reportingEnabled: true, signedOutEnabled: true, screenshotsEnabled: true, teamEmailEnabled: false,
  signedOutDailyCap: 50, teamRecipientDomain: null, adminBaseUrl: null, updatedAt: '2026-10-10T12:00:00.000Z',
};
