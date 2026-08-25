// ---------------------------------------------------------------------------
// Plan limits and subscription signage
//
// The employer plan gates (active jobs, saved templates) and the billing-state
// banners, as pure data. Nothing here renders, translates, or reads the DOM:
// every user-visible string is returned as an i18n KEY PATH plus interpolation
// params, and every action as a CTA descriptor. That keeps the decisions --
// which job is blocking, whether a past_due employer is still inside grace,
// which of two banners wins -- testable in vitest's `node` environment, and
// leaves the components to do nothing but look keys up.
//
// Why the limit codes need a module at all: the backend answers a reached plan
// limit with HTTP 403 (employer-jobs-create.ts:230, employer-jobs-update.ts:118,
// employer-templates-save.ts:175), so `classifyError` calls them `forbidden` --
// the same kind as a genuine permission denial, which renders "you do not have
// access" copy. The fix is NOT a new ErrorKind (`useErrorMessage` overrides are
// keyed by kind, so a new one would change copy for every unrelated 403); it is
// to branch on `err.code` BEFORE classifying. `planLimitModel` is that branch.
// ---------------------------------------------------------------------------

import { ApiError, BLOCKING_JOBS_LIMIT } from './api/errors';
import { EMPLOYER_PRO_PLAN_CODE } from './api/employer';
import type { EmployerBilling, Job } from './api/employer';

/** Re-exported so callers read the display cap off the model's own module. */
export { BLOCKING_JOBS_LIMIT };

export type BlockingJob = { id: string; title: string };

export type PlanLimitKind = 'active_jobs' | 'templates';

export type PlanLimitCta =
  | { kind: 'upgrade'; href: '/employer/billing'; labelKey: 'limit_dialog.cta_upgrade' }
  | { kind: 'pause_job'; href: '/employer/dashboard'; labelKey: 'limit_dialog.cta_pause_job' }
  | { kind: 'manage_templates'; href: '/employer/templates'; labelKey: 'limit_dialog.cta_manage_templates' };

export type PlanLimitModel = {
  kind: PlanLimitKind;
  bodyKey:
    | 'limit_dialog.body_jobs'
    | 'limit_dialog.body_jobs_zero'
    | 'limit_dialog.body_templates'
    | 'limit_dialog.body_templates_zero';
  bodyParams: { limit: number; used: number };
  /**
   * null when the backend named a plan the catalog copy does not cover.
   *
   * NOTE: relative to the `billing` namespace (`billing.plan_name.*` in
   * en.json/es.json -- both locales carry it), NOT to whichever namespace the
   * `limit_dialog.*` keys above end up in. A consumer translating with a
   * different namespace must resolve this one as `billing.${planNameKey}`.
   */
  planNameKey: 'plan_name.employer_free' | 'plan_name.employer_pro' | null;
  /** At most BLOCKING_JOBS_LIMIT, oldest first. `[]` is legitimate. */
  blockingJobs: readonly BlockingJob[];
  overflowCount: number;
  hintKey: 'limit_dialog.hint_jobs' | 'limit_dialog.hint_templates';
  ctas: readonly PlanLimitCta[];
};

const EMPLOYER_FREE_PLAN_CODE = 'employer_free';

const UPGRADE_CTA: PlanLimitCta = {
  kind: 'upgrade',
  href: '/employer/billing',
  labelKey: 'limit_dialog.cta_upgrade',
};

const PAUSE_JOB_CTA: PlanLimitCta = {
  kind: 'pause_job',
  href: '/employer/dashboard',
  labelKey: 'limit_dialog.cta_pause_job',
};

const MANAGE_TEMPLATES_CTA: PlanLimitCta = {
  kind: 'manage_templates',
  href: '/employer/templates',
  labelKey: 'limit_dialog.cta_manage_templates',
};

// The self-service action comes first: an employer who just wants to post the
// job they were posting can pause an old one without reaching for a card.
const JOBS_CTAS: readonly PlanLimitCta[] = [PAUSE_JOB_CTA, UPGRADE_CTA];
const TEMPLATES_CTAS: readonly PlanLimitCta[] = [MANAGE_TEMPLATES_CTA, UPGRADE_CTA];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function planNameKeyFor(planCode: unknown): PlanLimitModel['planNameKey'] {
  if (planCode === EMPLOYER_FREE_PLAN_CODE) return 'plan_name.employer_free';
  if (planCode === EMPLOYER_PRO_PLAN_CODE) return 'plan_name.employer_pro';
  return null;
}

/** A finite epoch for sortable dates; unparseable ones sort last, deterministically. */
function sortableTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * The active jobs currently holding the employer's slots: sorted created_at
 * ASC then id ASC -- the same "oldest keeps the slot" order the billing
 * enforcer counts in -- and capped at BLOCKING_JOBS_LIMIT.
 *
 * Rows that are not usable (missing id/title/created_at, or not active) are
 * skipped rather than rendered blank. Never throws: this feeds a dialog that
 * is already reporting one failure, so a malformed jobs list must degrade to
 * an empty list, never replace the dialog with a crash.
 */
export function blockingJobsFrom(
  jobs: ReadonlyArray<Pick<Job, 'id' | 'title' | 'status' | 'created_at'>> | null | undefined,
): BlockingJob[] {
  if (!Array.isArray(jobs)) return [];

  const usable = jobs.filter((row): row is Pick<Job, 'id' | 'title' | 'status' | 'created_at'> => {
    if (row === null || typeof row !== 'object') return false;
    const candidate = row as { id?: unknown; title?: unknown; status?: unknown; created_at?: unknown };
    return candidate.status === 'active'
      && isNonEmptyString(candidate.id)
      && isNonEmptyString(candidate.title)
      && isNonEmptyString(candidate.created_at);
  });

  return usable
    .slice()
    .sort((a, b) => {
      // Compared, not subtracted: an unparseable date is +Infinity, and
      // `finite - Infinity` is -Infinity, which would read as "a sorts first"
      // when it must sort last.
      const at = sortableTime(a.created_at);
      const bt = sortableTime(b.created_at);
      if (at !== bt) return at < bt ? -1 : 1;
      // Equal timestamps, or two unparseable ones -- id ASC keeps the order
      // stable so the dialog never reshuffles between renders.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, BLOCKING_JOBS_LIMIT)
    .map((row) => ({ id: row.id, title: row.title }));
}

/**
 * The dialog model for a reached plan limit, or null for anything else.
 *
 * `jobs` (the employer's current jobs, if the caller has them) only feeds the
 * active-jobs kind; a template limit never names jobs. A payload-supplied
 * `blocking_jobs` list wins over the derived one when the backend starts
 * sending it -- the server knows the authoritative set, the client is guessing
 * from whatever page data it happens to hold.
 */
export function planLimitModel(
  err: unknown,
  jobs?: ReadonlyArray<Pick<Job, 'id' | 'title' | 'status' | 'created_at'>> | null,
): PlanLimitModel | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code !== 'job_limit_reached' && err.code !== 'template_limit_reached') return null;

  const payload = err.payload ?? {};
  const planNameKey = planNameKeyFor(payload.plan_code);

  if (err.code === 'template_limit_reached') {
    const limit = payload.template_limit ?? 0;
    return {
      kind: 'templates',
      // The cap is reached by definition, so "used" is the cap itself -- the
      // backend does not send a separate count (employer-templates-save.ts:175).
      bodyKey: limit === 0 ? 'limit_dialog.body_templates_zero' : 'limit_dialog.body_templates',
      bodyParams: { limit, used: limit },
      planNameKey,
      blockingJobs: [],
      overflowCount: limit,
      hintKey: 'limit_dialog.hint_templates',
      ctas: TEMPLATES_CTAS,
    };
  }

  const limit = payload.active_job_limit ?? 0;
  const used = payload.active_jobs ?? 0;
  const fromPayload = payload.blocking_jobs;
  const blockingJobs = Array.isArray(fromPayload) && fromPayload.length > 0
    ? fromPayload.slice(0, BLOCKING_JOBS_LIMIT).map((row) => ({ id: row.id, title: row.title }))
    : blockingJobsFrom(jobs);

  return {
    kind: 'active_jobs',
    bodyKey: limit === 0 ? 'limit_dialog.body_jobs_zero' : 'limit_dialog.body_jobs',
    bodyParams: { limit, used },
    planNameKey,
    blockingJobs,
    // The jobs list can be absent (never fetched, or the fetch failed), in
    // which case every used slot lands in the overflow count.
    overflowCount: Math.max(0, used - blockingJobs.length),
    hintKey: 'limit_dialog.hint_jobs',
    ctas: JOBS_CTAS,
  };
}

// ---------------------------------------------------------------------------
// Subscription signage
// ---------------------------------------------------------------------------

/**
 * Subscription status enum from `subscriptions.status`
 * (infra/db/migrations/034), mapped to its copy key.
 *
 * Moved verbatim out of the billing page, which supplies the `billing`
 * namespace through `useTranslations('billing')` -- so these stay relative
 * (`status.past_due`, not `billing.status.past_due`).
 */
export const SUBSCRIPTION_STATUS_KEYS: Record<string, string> = {
  incomplete: 'status.incomplete',
  incomplete_expired: 'status.incomplete_expired',
  trialing: 'status.trialing',
  active: 'status.active',
  past_due: 'status.past_due',
  canceled: 'status.canceled',
  unpaid: 'status.unpaid',
  paused: 'status.paused',
};

/**
 * Statuses that mean the employer had a paid plan and no longer has a working
 * one. `incomplete` is deliberately absent: a checkout that never completed
 * leaves an employer who has simply never paid, which is the free story, not
 * the "re-subscribe" one.
 */
export const LAPSED_SUBSCRIPTION_STATUSES = [
  'past_due',
  'canceled',
  'unpaid',
  'paused',
  'incomplete_expired',
] as const;

const HEALTHY_SUBSCRIPTION_STATUSES: readonly string[] = ['active', 'trialing'];

export type SubscriptionSignage = {
  variant: 'free' | 'lapsed';
  tone: 'info' | 'warning';
  titleKey: 'signage.free_title' | 'signage.lapsed_title';
  bodyKey: 'signage.free_body' | 'signage.lapsed_body' | 'signage.lapsed_body_grace';
  bodyParams: { jobLimit?: number; templateLimit?: number };
  /**
   * Relative to the `billing` namespace (`status.past_due`), because it comes
   * from SUBSCRIPTION_STATUS_KEYS -- unlike the `signage.*` keys beside it.
   * The billing page resolves it as-is via `useTranslations('billing')`; a
   * banner rendered anywhere else must resolve it as `billing.${statusKey}`.
   */
  statusKey: string | null;
  ctaKey: 'signage.free_cta' | 'signage.lapsed_cta' | 'signage.lapsed_cta_grace';
  ctaHref: '/employer/billing';
  /** ISO, only when past_due and the grace window has not closed yet. */
  graceEndsAt: string | null;
  dismissKey: string;
} | null;

function isLapsed(status: string): boolean {
  return (LAPSED_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * The banner to show for the employer's billing state, or null when there is
 * nothing to say.
 *
 * Order matters, and lapsed is checked BEFORE free: the backend resolves a
 * lapsed Pro subscription down to `planCode: 'employer_free'`, so a naive
 * plan-code check would greet a customer whose card just failed with a "here
 * is what the free plan gives you" pitch. "Your subscription needs attention"
 * is both the more specific and the more actionable message.
 */
export function subscriptionSignage(
  billing: Pick<EmployerBilling, 'planCode' | 'activeJobLimit' | 'templateLimit' | 'subscription'> | null | undefined,
  now: Date = new Date(),
): SubscriptionSignage {
  if (!billing) return null;

  const status = billing.subscription?.status ?? null;

  if (status !== null && isLapsed(status)) {
    // Grace is a past_due-only concept: the payment failed but entitlements are
    // still intact until the window closes, so the copy must not claim lost
    // access. Every other lapsed status has already lost it.
    const graceEndsAt = billing.subscription?.grace_ends_at ?? null;
    const parsedGrace = graceEndsAt === null ? NaN : Date.parse(graceEndsAt);
    const inGrace = status === 'past_due'
      && !Number.isNaN(parsedGrace)
      && parsedGrace > now.getTime();

    return {
      variant: 'lapsed',
      tone: 'warning',
      titleKey: 'signage.lapsed_title',
      bodyKey: inGrace ? 'signage.lapsed_body_grace' : 'signage.lapsed_body',
      bodyParams: {},
      statusKey: SUBSCRIPTION_STATUS_KEYS[status] ?? null,
      ctaKey: inGrace ? 'signage.lapsed_cta_grace' : 'signage.lapsed_cta',
      ctaHref: '/employer/billing',
      graceEndsAt: inGrace ? graceEndsAt : null,
      // Keyed by status, not by grace: a dismissed past_due banner should not
      // come back the moment the grace window closes, but a move to `canceled`
      // is a new fact worth re-showing.
      dismissKey: `jale.signage.lapsed.${status}`,
    };
  }

  if (status !== null && HEALTHY_SUBSCRIPTION_STATUSES.includes(status)) return null;
  if (billing.planCode === EMPLOYER_PRO_PLAN_CODE) return null;

  return {
    variant: 'free',
    tone: 'info',
    titleKey: 'signage.free_title',
    bodyKey: 'signage.free_body',
    bodyParams: { jobLimit: billing.activeJobLimit, templateLimit: billing.templateLimit },
    statusKey: null,
    ctaKey: 'signage.free_cta',
    ctaHref: '/employer/billing',
    graceEndsAt: null,
    dismissKey: `jale.signage.free.${billing.planCode}`,
  };
}
