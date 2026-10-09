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
  // When the case entered its current status (migration 117), ISO.
  statusChangedAt: string;
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

// Roadmap 2c: ops health (migration 115). Lane ids are the SQL's; their labels
// and retry windows live in ops-health.ts.
export type MessageLane =
  | 'reply'
  | 'admin'
  | 'worker_notification'
  | 'employer_invite'
  | 'employer_freeform'
  | 'job_alert';

// One row of admin_analytics_message_backlog(): a lane's open messages right
// now, by age. Open rows are under 48 h old (older ones count as gave up);
// stuck = open past the lane's retry window (a subset of open).
export type MessageBacklogLane = {
  lane: MessageLane;
  openUnder1h: number;
  open1To24h: number;
  open24To48h: number;
  stuck: number;
  oldestStuckAt: string | null;
};

export type MessageFailureFigures = {
  created: number;
  gaveUp: number;
  deliveryFailed: number;
};

// One row of admin_analytics_message_failures: a (week, lane) pair. weekStart
// null = the whole window; lane null = every lane (a window row).
export type MessageFailuresWeekly = MessageFailureFigures & {
  weekStart: string | null;
  lane: MessageLane | null;
};

// Voice extraction counts attempts (rows), not distinct voice notes.
export type VoiceExtractionFigures = {
  processed: number;
  failed: number;
  failedTranscribe: number;
  failedEmptyTranscript: number;
  failedAudioRead: number;
  failedModelCall: number;
  failedBadJson: number;
  failedBadShape: number;
  failedPipelineError: number;
  // failure_kind NULL: failures from before migration 115.
  failedUnrecorded: number;
  usable: number;
  fullNameFound: number;
  cityFound: number;
  mainTradeFound: number;
  // Usable rows whose main trade is "other": the Other trade denominator.
  mainTradeOtherDue: number;
  mainTradeOtherFound: number;
  yearsExperienceFound: number;
  hasTransportationFound: number;
  availabilityFound: number;
};

// One row of admin_analytics_voice_extraction. model null = every row,
// attributed or not; a model row counts only that model's usable rows and its
// model_call / bad_json / bad_shape failures. weekStart null = the whole window.
export type VoiceExtractionWeekly = VoiceExtractionFigures & {
  weekStart: string | null;
  model: string | null;
};

export type TrustExtractionFigures = {
  extractions: number;
  failed: number;
  notEnoughDetail: number;
  // Mean non-empty sections of 5 over model-backed completed rows; null = none.
  avgSections: number | null;
};

// One row of admin_analytics_trust_extraction; extractorVersion null = all versions.
export type TrustExtractionWeekly = TrustExtractionFigures & {
  weekStart: string | null;
  extractorVersion: string | null;
};

export type BillingInboxFigures = {
  received: number;
  processed: number;
  skipped: number;
  failed: number;
  retried: number;
  paymentFailedInvoices: number;
};

// One row of admin_analytics_billing_inbox; eventType null = all event types.
export type BillingInboxWeekly = BillingInboxFigures & {
  weekStart: string | null;
  eventType: string | null;
};

// admin_analytics_billing_inbox_now(). Stuck = received, never claimed or
// with an expired claim; failed now = failed. Both count only events
// received in the last hour; oldest = the oldest of those (null when none).
// unresolvedOlder = dead-lettered in the last 14 days (received 1 h-14 d ago,
// still stuck or failed): they can be redriven from the queue; older events
// have left the queue and must be resent from Stripe.
export type BillingInboxNow = {
  stuckReceived: number;
  failedNow: number;
  unresolvedOlder: number;
  oldestStuckAt: string | null;
};

// Roadmap 2d: admin queues (migration 117). Start over and back by
// onboarding step, operator resets, and the applicant digest email.
export type RestartFigures = {
  // Distinct workers who were at the step in the period: they arrived there by
  // any move other than start over, back or a voice-note retry, or they started
  // over or went back from it. restartWorkers and backWorkers never exceed it.
  reached: number;
  restartWorkers: number;
  restartPresses: number;
  backWorkers: number;
  backPresses: number;
};

// One row of admin_analytics_onboarding_restarts: a (week, door, step) with
// any count. The step is the one the worker left; stepKey null = all steps
// (workers distinct across steps, presses summed). weekStart null = the whole
// window (workers distinct across it); 'all' is computed in SQL.
export type OnboardingRestart = RestartFigures & {
  weekStart: string | null;
  door: FunnelDoor;
  stepKey: string | null;
};

// One row of admin_analytics_operator_resets. bulk false: one (week, masked
// reason) group, runStartedAt null. bulk true: one bulk run (10+ workers reset
// with the same reason within an hour), left out of the counts; runStartedAt
// is its first in-window reset (a run that began before the window reports
// only its in-window part) and weekStart that reset's week.
export type OperatorReset = {
  weekStart: string;
  reason: string;
  workers: number;
  resets: number;
  bulk: boolean;
  runStartedAt: string | null;
};

// admin_analytics_digest_adoption(), right now: non-test employers; of them,
// digest on; of those, an email address the digest producer would send to.
export type DigestAdoption = {
  employers: number;
  digestOn: number;
  digestOnWithEmail: number;
};

export type DigestSendFigures = {
  emailed: number;
  sent: number;
  // Gave up: failed on the 5th attempt.
  failed: number;
  // send_unknown: the send timed out; never retried, it may have arrived.
  unknown: number;
  // Pending, or failed with fewer than 5 attempts (it will be retried).
  inProgress: number;
  // Distinct employers with a sent digest (distinct across the window on the window row).
  employersReached: number;
};

// One row of admin_analytics_digest_sends: every week of the window
// (zero-filled by SQL), plus the whole window when weekStart is null.
export type DigestSendsWeekly = DigestSendFigures & { weekStart: string | null };
