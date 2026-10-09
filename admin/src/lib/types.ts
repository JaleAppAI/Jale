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

export type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  piiReveal: boolean;
  summary: string;
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
  totalVerifiedWorkers: number;
};

export type SignupBucket = {
  bucketStart: string;
  workerSignups: number;
  employerSignups: number;
  workerSignupsVerified: number;
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

// Roadmap 2a: the worker onboarding funnel (migration 113).
export type FunnelWeeks = 4 | 8 | 12;
export type FunnelDoor = 'all' | 'whatsapp' | 'web';

export type CohortCounts = {
  cohortWeek: string;
  started: number;
  codeRequested: number;
  verified: number;
  acceptedTerms: number;
  finishedProfile: number;
  ready: number;
  declined: number;
  inProgress: number;
  abandoned: number;
};

export type OnboardingCohort = CohortCounts & { door: 'whatsapp' | 'web' };

export type OnboardingStalled = {
  door: 'whatsapp' | 'web' | 'other';
  stepKey: string;
  workers: number;
};

export type FunnelStageKey =
  | 'started'
  | 'codeRequested'
  | 'verified'
  | 'acceptedTerms'
  | 'finishedProfile'
  | 'ready';

export type FunnelStage = {
  key: FunnelStageKey;
  label: string;
  count: number;
  ofStarted: string | null;
  ofPrevious: string | null;
};

export type StalledStep = { stepKey: string; label: string; workers: number };

// Roadmap 2b: employer health (migration 114). Durations are hours (first
// response, reply) or days (time to hire); null = nothing to time (SQL NULL).
export type EmployerHealthFigures = {
  applications: number;
  answered: number;
  answeredUntimed: number;
  unanswered7d: number;
  // Applications applied 7+ days ago: the denominator of the unanswered share.
  applicationsDue: number;
  firstResponseP50Hours: number | null;
  firstResponseP75Hours: number | null;
  workerTurns: number;
  turnsUnanswered7d: number;
  // Worker turns started 7+ days ago (closed-with-no-reply excluded).
  turnsDue: number;
  replyP50Hours: number | null;
  replyP75Hours: number | null;
  hires: number;
  hiresApproximate: number;
  timeToHireP50Days: number | null;
  timeToHireP75Days: number | null;
};

// One row of admin_analytics_employer_weekly: a week, or the whole window
// when weekStart is null (activeJobs is set on that row only).
export type EmployerWeekly = EmployerHealthFigures & {
  weekStart: string | null;
  activeJobs: number | null;
};

export type EmployerWeek = EmployerHealthFigures & { weekStart: string };

export type EmployerHealthSummary = EmployerHealthFigures & { activeJobs: number };

export type EmployerWeekTableRow = EmployerWeek & {
  label: string;
  settling: boolean;
  approximate: boolean;
};

export type SlowestEmployer = {
  employerId: string;
  displayName: string;
  applications: number;
  unanswered7d: number;
  firstResponseP50Hours: number | null;
  activeJobs: number;
};

export type StaleJob = {
  jobId: string;
  title: string;
  employerId: string;
  displayName: string;
  postedAt: string;
  lastEmployerActionAt: string;
  daysIdle: number;
  waitingApplicants: number;
  lastApplicationAt: string | null;
};
