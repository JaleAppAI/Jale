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
import { isTeamManagementEnabled } from './feature-flags';

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
    // The PRE-flight sentence: said before the employer has typed anything,
    // so unlike `body_jobs` it is phrased as a refusal to start rather than as
    // a report of a failed publish. See `activeJobsPreflightModel`.
    | 'limit_dialog.body_jobs_preflight'
    | 'limit_dialog.body_jobs_zero'
    | 'limit_dialog.body_templates'
    // Phase 3: `body_templates` without "or upgrade", for a Pro owner.
    | 'limit_dialog.body_templates_no_upgrade'
    // Phase 3: a foreman deletes only templates they created; the count is the company's.
    | 'limit_dialog.body_templates_foreman'
    | 'limit_dialog.body_templates_zero'
    // Phase 3: a foreman cannot change the plan, so they are told who can.
    | 'limit_dialog.foreman_body'
    // Phase 3: the same on a Pro company, where there is nothing to upgrade to.
    | 'limit_dialog.foreman_body_pro';
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
  hintKey:
    | 'limit_dialog.hint_jobs'
    | 'limit_dialog.hint_templates'
    // Phase 3: an owner already on the highest plan is pointed at freeing a slot.
    | 'limit_dialog.pro_owner_hint';
  ctas: readonly PlanLimitCta[];
};

/**
 * Who is reading the dialog (Phase 3). `role` null or absent is the owner, as
 * for an API from before companies; `planCode` is the company's current plan.
 * Leaving the whole audience out keeps the Phase 2 model exactly.
 */
export type PlanLimitAudience = {
  role?: 'owner' | 'foreman' | null;
  planCode?: string | null;
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

/**
 * The model as its reader may act on it. "Upgrade plan" is a dead end for two
 * readers: a foreman (only the owner pays; the API answers 403 owner_required)
 * and an owner already on Pro (there is no higher plan). Both lose the CTA.
 * Every other reader, and a call without an audience, gets the model unchanged.
 *
 * The bodies:
 * - A foreman, active jobs: on a Free company, `foreman_body` ("ask your owner
 *   to upgrade" -- the owner can); on a Pro company, `foreman_body_pro`
 *   ("pause or close one of your jobs, or ask your owner to free a slot").
 * - A foreman, templates: `body_templates_foreman`. A foreman can delete only
 *   the templates they created (employer-templates-delete.ts answers 403
 *   `forbidden` for any other), while the limit counts the company's: "delete
 *   one you created, or ask your owner". With a zero limit there is nothing to
 *   delete, so `body_templates_zero` ("your plan doesn't include them") stays.
 * - A Pro owner: no body says "upgrade". Every active-jobs body becomes
 *   `body_jobs` (the preflight and zero-limit ones both end in an upgrade),
 *   `body_templates` becomes `body_templates_no_upgrade`, and
 *   `body_templates_zero` stays (it never mentions upgrading).
 *
 * The hint: a Pro owner's active-jobs hint is `pro_owner_hint`; a template
 * limit keeps `hint_templates`, since pausing a job frees no template slot.
 * A foreman keeps the kind's own hint.
 */
function forAudience(model: PlanLimitModel, audience: PlanLimitAudience | undefined): PlanLimitModel {
  if (!audience || upgradeOffered(audience)) return model;
  const withoutUpgrade = model.ctas.filter((cta) => cta.kind !== 'upgrade');
  if (audience.role === 'foreman') {
    const bodyKey: PlanLimitModel['bodyKey'] = model.kind === 'templates'
      ? (model.bodyKey === 'limit_dialog.body_templates' ? 'limit_dialog.body_templates_foreman' : model.bodyKey)
      : (isProPlan(audience.planCode) ? 'limit_dialog.foreman_body_pro' : 'limit_dialog.foreman_body');
    return { ...model, bodyKey, ctas: withoutUpgrade };
  }
  if (model.kind === 'templates') {
    return {
      ...model,
      bodyKey: model.bodyKey === 'limit_dialog.body_templates' ? 'limit_dialog.body_templates_no_upgrade' : model.bodyKey,
      ctas: withoutUpgrade,
    };
  }
  return { ...model, bodyKey: 'limit_dialog.body_jobs', hintKey: 'limit_dialog.pro_owner_hint', ctas: withoutUpgrade };
}

function isProPlan(planCode: unknown): boolean {
  return planCode === EMPLOYER_PRO_PLAN_CODE;
}

/**
 * Whether "upgrade" is something this reader can act on: not for a foreman
 * (only the owner pays) nor for an owner already on Pro (there is no higher
 * plan). No audience -- the team flag off -- is Phase 2: always offered. Every
 * upgrade link outside the dialog (the templates page's note, the posted
 * panel, the dashboard meter) follows the same rule.
 */
export function upgradeOffered(audience: PlanLimitAudience | undefined): boolean {
  if (!audience) return true;
  if (audience.role === 'foreman') return false;
  return !isProPlan(audience.planCode);
}

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

/** A reached saved-template limit, before `forAudience`. */
function templatesModel(limit: number, planNameKey: PlanLimitModel['planNameKey']): PlanLimitModel {
  return {
    kind: 'templates',
    // The cap is reached by definition, so "used" is the cap itself -- the
    // backend does not send a separate count (employer-templates-save.ts:175).
    bodyKey: limit === 0 ? 'limit_dialog.body_templates_zero' : 'limit_dialog.body_templates',
    bodyParams: { limit, used: limit },
    planNameKey,
    blockingJobs: [],
    // No jobs are named for a template limit, so there is nothing to overflow.
    overflowCount: 0,
    hintKey: 'limit_dialog.hint_templates',
    ctas: TEMPLATES_CTAS,
  };
}

/**
 * The template-limit model for a page that knows the limit is reached without
 * a 403 (the templates page's at-limit note), so the note and the save
 * dialog's body come from the same decision. `audience.planCode` is the plan.
 */
export function templateLimitModel(limit: number, audience?: PlanLimitAudience): PlanLimitModel {
  return forAudience(templatesModel(limit, planNameKeyFor(audience?.planCode)), audience);
}

/**
 * The dialog model for a reached plan limit, or null for anything else.
 *
 * `jobs` (the employer's current jobs, if the caller has them) only feeds the
 * active-jobs kind; a template limit never names jobs. A payload-supplied
 * `blocking_jobs` list wins over the derived one when the backend starts
 * sending it -- the server knows the authoritative set, the client is guessing
 * from whatever page data it happens to hold.
 *
 * `audience` (Phase 3) is the reader's role and the company's plan; see
 * `forAudience`. Callers pass it only with the team flag on.
 */
export function planLimitModel(
  err: unknown,
  jobs?: ReadonlyArray<Pick<Job, 'id' | 'title' | 'status' | 'created_at'>> | null,
  audience?: PlanLimitAudience,
): PlanLimitModel | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code !== 'job_limit_reached' && err.code !== 'template_limit_reached') return null;

  const payload = err.payload ?? {};
  const planNameKey = planNameKeyFor(payload.plan_code);
  // A caller that does not know the plan (its billing read failed) still gets
  // the Pro reading from the plan the 403 itself names.
  const reader = audience && { ...audience, planCode: audience.planCode ?? payload.plan_code ?? null };

  if (err.code === 'template_limit_reached') {
    return forAudience(templatesModel(payload.template_limit ?? 0, planNameKey), reader);
  }

  const limit = payload.active_job_limit ?? 0;
  const used = payload.active_jobs ?? 0;
  const fromPayload = payload.blocking_jobs;
  const blockingJobs = Array.isArray(fromPayload) && fromPayload.length > 0
    ? fromPayload.slice(0, BLOCKING_JOBS_LIMIT).map((row) => ({ id: row.id, title: row.title }))
    : blockingJobsFrom(jobs);

  return forAudience({
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
  }, reader);
}

/**
 * The company's active-job count: the caller's live own count plus
 * `billing.otherMembersActiveJobs` (the active jobs of members whose jobs the
 * caller's list cannot show; 0 for the owner). A missing, negative or
 * non-integer figure counts as 0, so the owner and an API from before Phase 2
 * get `activeCount` exactly. The post-a-job gate and `PlanUsageMeter` both use
 * this, so the two can never disagree.
 */
export function companyActiveJobCount(
  billing: Pick<EmployerBilling, 'otherMembersActiveJobs'> | null | undefined,
  activeCount: number,
): number {
  const others = billing?.otherMembersActiveJobs;
  return activeCount + (typeof others === 'number' && Number.isInteger(others) && others > 0 ? others : 0);
}

/**
 * The company's saved templates, as counted against `templateLimit` (Phase 3:
 * `billing.templateUsage`, company-wide), kept live against the page's list.
 *
 * `templateUsage` is read once, with the page; the list is what a save or a
 * delete updates. So the count is the list now plus the templates billing
 * counted that the list did not hold when billing was read
 * (`listedWhenBillingRead`, by default the list now): a delete frees its slot
 * at once, as it did when the list was the whole count. A missing, negative or
 * non-integer `templateUsage` (an API from before Phase 2) gives the list
 * count, and with no list either, null.
 */
export function companyTemplateCount(
  billing: Pick<EmployerBilling, 'templateUsage'> | null | undefined,
  listed: number | null,
  listedWhenBillingRead: number | null = listed,
): number | null {
  const usage = billing?.templateUsage;
  if (typeof usage !== 'number' || !Number.isInteger(usage) || usage < 0) return listed;
  if (listed === null || listedWhenBillingRead === null) return usage;
  return listed + Math.max(0, usage - listedWhenBillingRead);
}

/**
 * The same dialog model, decided BEFORE anything is submitted.
 *
 * `planLimitModel` above reads a 403 the server already sent. This one answers
 * "would a post be refused?" from what the page is holding, so the employer
 * can be told there is no slot while their draft is still unwritten. That is
 * the whole point: the old flow let them fill in all three wizard steps and
 * only then showed the limit -- and the notice's one self-service way out
 * ("Pause a job") navigates to the dashboard, which resets the wizard and
 * throws the draft away.
 *
 * Returns null -- meaning "do not gate" -- whenever the answer is not a
 * confident yes:
 *  - no `billing` (the dashboard fetches it best-effort against a 2.5s
 *    deadline, so "we don't know" is a normal state, and locking someone out
 *    of posting on a slow request would be a far worse bug than the one this
 *    fixes);
 *  - a non-integer limit from a malformed catalog row;
 *  - a count under the cap.
 * In every one of those cases the publish-time 403 remains the backstop, which
 * is why this gate is allowed to be optimistic.
 *
 * `activeCount` is passed in rather than read off `billing.activeJobUsage` on
 * purpose. `activeJobUsage` is a snapshot from page load; the dashboard now
 * pauses and resumes jobs in place, so the usage figure goes stale the moment
 * it does -- and a gate that still blocked after the employer freed a slot
 * would be indistinguishable from the bug. The caller passes the count it
 * derives from the live jobs list, which is also the number `PlanUsageMeter`
 * shows the employer in the same panel. Since Phase 2 both add
 * `billing.otherMembersActiveJobs`, the company's active jobs that list cannot show.
 *
 * `audience` (Phase 3) defaults, with the team flag on, to the one `billing`
 * itself names (`role`, `planCode`), so a caller that only hands over billing
 * still tells a foreman to ask the owner. With the flag off there is no
 * default and the model is Phase 2's.
 */
export function activeJobsPreflightModel(
  billing: Pick<EmployerBilling, 'planCode' | 'activeJobLimit' | 'otherMembersActiveJobs' | 'role'> | null | undefined,
  activeCount: number,
  jobs?: ReadonlyArray<Pick<Job, 'id' | 'title' | 'status' | 'created_at'>> | null,
  audience?: PlanLimitAudience,
): PlanLimitModel | null {
  if (!billing) return null;
  const limit = billing.activeJobLimit;
  if (!Number.isInteger(limit) || limit < 0) return null;
  // The limit is the company's (Phase 2). A foreman's list shows only their
  // own jobs, so the jobs of other members come from billing -- a load-time
  // figure, but one the caller cannot change from this page. The owner's
  // list already holds every member's job, and the API sends 0 for them.
  const used = companyActiveJobCount(billing, activeCount);
  if (used < limit) return null;

  const blockingJobs = blockingJobsFrom(jobs);

  return forAudience({
    kind: 'active_jobs',
    // A plan with no postings at all is not "you have used them up" -- it is
    // "this plan does not include the thing", which is `body_jobs_zero`'s job
    // and reads the same whether the server or this function decided it.
    bodyKey: limit === 0 ? 'limit_dialog.body_jobs_zero' : 'limit_dialog.body_jobs_preflight',
    bodyParams: { limit, used },
    planNameKey: planNameKeyFor(billing.planCode),
    blockingJobs,
    overflowCount: Math.max(0, used - blockingJobs.length),
    hintKey: 'limit_dialog.hint_jobs',
    ctas: JOBS_CTAS,
  }, audience ?? (isTeamManagementEnabled() ? { role: billing.role ?? null, planCode: billing.planCode } : undefined));
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

/**
 * Whether a billing READ shows the account on a working paid plan: the one
 * state in which `subscriptionSignage` has nothing to say BECAUSE of the plan.
 *
 * `null`/`undefined` is not healthy -- it is the dashboard's best-effort read
 * failing or timing out, which is the absence of an answer. A canceled
 * subscription is lapsed, not healthy (owner decision D-P1, sprint 28).
 */
export function isHealthyPaidPlan(
  billing: Pick<EmployerBilling, 'planCode' | 'activeJobLimit' | 'templateLimit' | 'subscription'> | null | undefined,
): boolean {
  return billing != null && subscriptionSignage(billing) === null;
}
