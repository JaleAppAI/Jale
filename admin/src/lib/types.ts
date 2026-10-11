export type AdminCaseType =
  | 'help_request'
  | 'verification_blocker'
  | 'outbound_failure'
  | 'conversation_stuck';

export type AdminCaseStatus = 'open' | 'pending_worker' | 'pending_admin' | 'resolved' | 'dismissed';

export type AdminRole = 'admin_readonly' | 'admin_ops' | 'admin_superadmin';

export type AdminCase = {
  id: string;
  caseNumber?: string;
  type: AdminCaseType;
  status: AdminCaseStatus;
  priority: number;
  summary: string;
  workerName: string;
  workerLabel: string;
  workerId: string;
  conversationId: string;
  employerName?: string;
  verificationType?: 'worker' | 'employer';
  assignedAdmin: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: string;
  maskedPhone: string;
  maskedEmail?: string;
  notes: string[];
  timeline: AdminTimelineEvent[];
};

export type AdminTimelineEvent = {
  id: string;
  at: string;
  actor: 'system' | 'worker' | 'admin';
  title: string;
  detail: string;
  piiReveal?: boolean;
};

// Roadmap 1b: one row of admin_identity_lockouts() (migration 102).
export type IdentityLockoutKind = 'lockout' | 'stuck';

export type IdentityLockoutOutcome =
  | 'locked'
  | 'lock_expired'
  | 'retrying'
  | 'verified'
  | 'superseded'
  | 'code_expired';

export type IdentityLockout = {
  challengeId: string;
  kind: IdentityLockoutKind;
  maskedPhone: string | null;
  outcome: IdentityLockoutOutcome;
  lockoutCount: number;
  attempts: number;
  lockedUntil: string | null;
  lastEventAt: string;
  startedAt: string;
};

// One row of the access history (jale_audit.history_search): an access event,
// a data change, or a record from the earlier action log. Optional fields are
// absent when the source does not have them.
export type AccessHistorySource = 'event' | 'change' | 'legacy';

export type AccessHistoryEntry = {
  /** `${source}:${entry id}`, unique across sources. */
  key: string;
  source: AccessHistorySource;
  /** UTC, ISO 8601. */
  occurredAt: string;
  kind?: string;
  outcome?: string;
  actorKind?: string;
  actorId?: string;
  actorRole?: string;
  actorSession?: string;
  actorEmail?: string;
  channel?: string;
  surface?: string;
  categories: string[];
  subjectUserIds: string[];
  recordType?: string;
  recordIds: string[];
  resultCount?: number;
  fieldNames: string[];
  purposeKind?: string;
  purposeId?: string;
  /** A reveal's reason, or a legacy record's justification as the freeze left it. */
  reason?: string;
  linkExpiresAt?: string;
  part?: number;
  parts?: number;
  tableName?: string;
  operation?: string;
  rowCount?: number;
  changedFields: string[];
  contextStatus?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  summary?: string;
  piiReveal: boolean;
  requestId?: string;
};

export type AnalyticsRange = '7d' | '30d' | '90d';
export type AnalyticsBucket = 'day' | 'week';

// Signups chart mode: 'total' plots the running account count, 'new' plots
// accounts created per bucket.
export type SignupsView = 'total' | 'new';

export type AnalyticsTotals = {
  totalWorkers: number;
  totalEmployers: number;
  payingEmployers: number;
  jobsActive: number;
  jobsPaused: number;
  jobsFilled: number;
  jobsClosed: number;
  hiresTotal: number;
  jobsWithHire: number;
};

export type SignupBucket = {
  bucketStart: string;
  workerSignups: number;
  employerSignups: number;
};

export type JobsActivityBucket = {
  bucketStart: string;
  jobsPosted: number;
  applicationsSubmitted: number;
};

export type MessageTrafficBucket = {
  bucketStart: string;
  jobMessagesOut: number;
  jobMessagesIn: number;
  jobMessagesFailed: number;
  waInbound: number;
  waOutbound: number;
  waFailed: number;
};

export type PayingEmployer = {
  employerId: string;
  displayName: string;
  planCode: string;
  status: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
};
