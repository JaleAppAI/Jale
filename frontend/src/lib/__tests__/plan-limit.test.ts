import { describe, expect, it } from 'vitest';
import {
  BLOCKING_JOBS_LIMIT,
  LAPSED_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_KEYS,
  blockingJobsFrom,
  planLimitModel,
  subscriptionSignage,
} from '../plan-limit';
import { ApiError, classifyError } from '../api/errors';
import { EMPLOYER_PRO_PLAN_CODE } from '../api/employer';
import type { BillingSubscription, EmployerBilling, Job } from '../api/employer';

// ---------------------------------------------------------------------------
// Fixtures
//
// `planLimitModel` only ever reads four columns off a job row, so the tests
// build exactly that slice rather than a full `Job` -- the signature is typed
// as a `Pick`, so a whole job is not needed to pin behaviour.
// ---------------------------------------------------------------------------

type JobRow = Pick<Job, 'id' | 'title' | 'status' | 'created_at'>;

function job(id: string, title: string, created_at: string, status: Job['status'] = 'active'): JobRow {
  return { id, title, status, created_at };
}

/** The employer's own two jobs from the sprint-21 bug report. */
const LANDSCAPE = job('job-landscape', 'Landscape Maintenance Tech', '2026-06-17T09:00:00.000Z');
const CONCRETE = job('job-concrete', 'Concrete Finisher', '2026-07-15T09:00:00.000Z', 'paused');

function billing(over: Partial<EmployerBilling> = {}): Pick<
  EmployerBilling,
  'planCode' | 'activeJobLimit' | 'templateLimit' | 'subscription'
> {
  return {
    planCode: 'employer_free',
    activeJobLimit: 1,
    templateLimit: 1,
    subscription: null,
    ...over,
  };
}

function subscription(over: Partial<NonNullable<BillingSubscription>> = {}): BillingSubscription {
  return {
    plan_code: EMPLOYER_PRO_PLAN_CODE,
    status: 'active',
    current_period_start: '2026-08-01T00:00:00.000Z',
    current_period_end: '2026-09-01T00:00:00.000Z',
    cancel_at_period_end: false,
    grace_ends_at: null,
    ...over,
  };
}

const NOW = new Date('2026-08-24T12:00:00.000Z');

// ---------------------------------------------------------------------------

describe('planLimitModel -- case 1: the job-limit regression pin', () => {
  const err = new ApiError(403, 'job_limit_reached', {
    plan_code: 'employer_free',
    active_job_limit: 1,
    active_jobs: 1,
  });

  it('builds an active_jobs model naming the one job that holds the slot', () => {
    const model = planLimitModel(err, [LANDSCAPE, CONCRETE]);

    expect(model).not.toBeNull();
    expect(model!.kind).toBe('active_jobs');
    expect(model!.bodyKey).toBe('limit_dialog.body_jobs');
    expect(model!.bodyParams).toEqual({ limit: 1, used: 1 });
    expect(model!.blockingJobs).toEqual([
      { id: 'job-landscape', title: 'Landscape Maintenance Tech' },
    ]);
    expect(model!.overflowCount).toBe(0);
    expect(model!.hintKey).toBe('limit_dialog.hint_jobs');
    expect(model!.ctas.map((cta) => cta.kind)).toEqual(['pause_job', 'upgrade']);
  });

  it('documents that the classifier still calls this 403 `forbidden`', () => {
    // The dialog fix is a branch on `err.code` BEFORE the classifier runs --
    // NOT a new ErrorKind. `useErrorMessage` overrides are keyed by kind, so
    // adding a kind here would change copy for every unrelated 403.
    expect(classifyError(err).kind).toBe('forbidden');
    expect(classifyError(err).payload).toEqual({
      plan_code: 'employer_free',
      active_job_limit: 1,
      active_jobs: 1,
    });
  });
});

describe('planLimitModel -- case 2: anything that is not a plan-limit error', () => {
  it.each([
    ['a plain Error', new Error('x')],
    ['a generic 403', new ApiError(403, 'forbidden')],
    ['an unrelated 409', new ApiError(409, 'field_locked')],
    ['a string', 'job_limit_reached'],
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s', (_label, err) => {
    expect(planLimitModel(err)).toBeNull();
  });
});

describe('planLimitModel -- case 3: the jobs list is unavailable', () => {
  const err = new ApiError(403, 'job_limit_reached', {
    plan_code: 'employer_free',
    active_job_limit: 1,
    active_jobs: 3,
  });

  it.each([
    ['no jobs argument', undefined],
    ['a null jobs list (fetch failed)', null],
    ['an empty jobs list', []],
  ])('still models the limit with %s, pushing the whole count into the overflow', (_label, jobs) => {
    const model = planLimitModel(err, jobs as JobRow[] | null | undefined);

    expect(model).not.toBeNull();
    expect(model!.blockingJobs).toEqual([]);
    expect(model!.overflowCount).toBe(3);
    expect(model!.bodyParams).toEqual({ limit: 1, used: 3 });
  });
});

describe('planLimitModel -- case 4: ordering and the blocking-jobs cap', () => {
  it('keeps the three oldest active jobs, oldest first, and overflows the rest', () => {
    const shuffled: JobRow[] = [
      job('j-e', 'Roofer', '2026-05-02T00:00:00.000Z'),
      job('j-b', 'Framer', '2026-01-10T00:00:00.000Z'),
      job('j-d', 'Painter', '2026-04-21T00:00:00.000Z'),
      job('j-a', 'Electrician', '2026-01-10T00:00:00.000Z'),
      job('j-c', 'Plumber', '2026-03-05T00:00:00.000Z'),
    ];

    // j-a and j-b share a created_at -- id ASC breaks the tie, so j-a leads.
    expect(blockingJobsFrom(shuffled)).toEqual([
      { id: 'j-a', title: 'Electrician' },
      { id: 'j-b', title: 'Framer' },
      { id: 'j-c', title: 'Plumber' },
    ]);
    expect(blockingJobsFrom(shuffled)).toHaveLength(BLOCKING_JOBS_LIMIT);
  });

  it('sorts an unparseable created_at last instead of first', () => {
    // `finite - Infinity` is -Infinity, so a subtracting comparator would rank
    // the garbage date ahead of every real one.
    const rows: JobRow[] = [
      job('j-garbage', 'Garbage Date', 'not-a-date'),
      job('j-real', 'Real Date', '2026-03-01T00:00:00.000Z'),
    ];

    expect(blockingJobsFrom(rows)).toEqual([
      { id: 'j-real', title: 'Real Date' },
      { id: 'j-garbage', title: 'Garbage Date' },
    ]);
  });

  it('overflows a Pro employer at the cap: 10 active jobs name 3 and count 7', () => {
    const err = new ApiError(403, 'job_limit_reached', {
      plan_code: EMPLOYER_PRO_PLAN_CODE,
      active_job_limit: 10,
      active_jobs: 10,
    });
    const many = Array.from({ length: 10 }, (_unused, i) =>
      job(`j-${String(i).padStart(2, '0')}`, `Job ${i}`, `2026-0${(i % 9) + 1}-01T00:00:00.000Z`),
    );

    const model = planLimitModel(err, many);

    expect(model!.blockingJobs).toHaveLength(3);
    expect(model!.overflowCount).toBe(7);
    expect(model!.planNameKey).toBe('plan_name.employer_pro');
  });
});

describe('planLimitModel -- case 5: malformed and non-active rows', () => {
  it('skips rows that are not usable and never throws', () => {
    const rows = [
      { id: 'ok', title: 'Usable', status: 'active', created_at: '2026-02-01T00:00:00.000Z' },
      { id: 'no-date', title: 'Missing created_at', status: 'active', created_at: null },
      { id: 'no-title', title: null, status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
      { id: null, title: 'Missing id', status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'blank', title: '   ', status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'paused', title: 'Paused', status: 'paused', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'closed', title: 'Closed', status: 'closed', created_at: '2026-01-01T00:00:00.000Z' },
      null,
      undefined,
      'not a row',
    ] as unknown as JobRow[];

    expect(() => blockingJobsFrom(rows)).not.toThrow();
    expect(blockingJobsFrom(rows)).toEqual([{ id: 'ok', title: 'Usable' }]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-array', 'nope'],
  ])('returns [] for %s rather than throwing', (_label, value) => {
    expect(blockingJobsFrom(value as JobRow[] | null | undefined)).toEqual([]);
  });
});

describe('planLimitModel -- case 6: a zero limit', () => {
  it('uses body_jobs_zero when the active-job limit is 0', () => {
    const model = planLimitModel(
      new ApiError(403, 'job_limit_reached', { plan_code: 'employer_free', active_job_limit: 0, active_jobs: 0 }),
    );

    expect(model!.bodyKey).toBe('limit_dialog.body_jobs_zero');
    expect(model!.bodyParams).toEqual({ limit: 0, used: 0 });
  });

  it('uses body_jobs_zero when the payload omits the limit entirely', () => {
    const model = planLimitModel(new ApiError(403, 'job_limit_reached', {}));

    expect(model!.bodyKey).toBe('limit_dialog.body_jobs_zero');
    expect(model!.bodyParams).toEqual({ limit: 0, used: 0 });
    expect(model!.planNameKey).toBeNull();
  });

  it('uses body_templates_zero when the template limit is 0', () => {
    const model = planLimitModel(
      new ApiError(403, 'template_limit_reached', { plan_code: 'employer_free', template_limit: 0 }),
    );

    expect(model!.kind).toBe('templates');
    expect(model!.bodyKey).toBe('limit_dialog.body_templates_zero');
    expect(model!.bodyParams).toEqual({ limit: 0, used: 0 });
    expect(model!.blockingJobs).toEqual([]);
  });
});

describe('planLimitModel -- case 7: the template limit', () => {
  const err = new ApiError(403, 'template_limit_reached', {
    plan_code: 'employer_free',
    template_limit: 2,
  });

  it('models a reached template cap as used === limit', () => {
    const model = planLimitModel(err, [LANDSCAPE]);

    expect(model!.kind).toBe('templates');
    expect(model!.bodyKey).toBe('limit_dialog.body_templates');
    expect(model!.bodyParams).toEqual({ limit: 2, used: 2 });
    expect(model!.hintKey).toBe('limit_dialog.hint_templates');
    expect(model!.ctas.map((cta) => cta.kind)).toEqual(['manage_templates', 'upgrade']);
    expect(model!.overflowCount).toBe(2);
  });

  it('never names blocking jobs for a template limit, even when jobs are supplied', () => {
    expect(planLimitModel(err, [LANDSCAPE])!.blockingJobs).toEqual([]);
  });

  it('points the primary CTA at the templates page and the upgrade at billing', () => {
    expect(planLimitModel(err)!.ctas).toEqual([
      { kind: 'manage_templates', href: '/employer/templates', labelKey: 'limit_dialog.cta_manage_templates' },
      { kind: 'upgrade', href: '/employer/billing', labelKey: 'limit_dialog.cta_upgrade' },
    ]);
  });
});

describe('planLimitModel -- case 8: planNameKey', () => {
  it.each([
    ['employer_free', 'plan_name.employer_free'],
    [EMPLOYER_PRO_PLAN_CODE, 'plan_name.employer_pro'],
  ])('maps the known plan code %s', (planCode, expected) => {
    const model = planLimitModel(
      new ApiError(403, 'job_limit_reached', { plan_code: planCode, active_job_limit: 1, active_jobs: 1 }),
    );
    expect(model!.planNameKey).toBe(expected);
  });

  it.each([
    ['an unknown code', 'employer_enterprise'],
    ['an empty string', ''],
  ])('returns null for %s rather than inventing a key', (_label, planCode) => {
    const model = planLimitModel(
      new ApiError(403, 'job_limit_reached', { plan_code: planCode, active_job_limit: 1, active_jobs: 1 }),
    );
    expect(model!.planNameKey).toBeNull();
  });
});

describe('planLimitModel -- payload-supplied blocking_jobs', () => {
  it('prefers a well-formed payload list over the derived one', () => {
    const err = new ApiError(403, 'job_limit_reached', {
      plan_code: 'employer_free',
      active_job_limit: 1,
      active_jobs: 1,
      blocking_jobs: [{ id: 'from-server', title: 'Server Said So' }],
    });

    expect(planLimitModel(err, [LANDSCAPE])!.blockingJobs).toEqual([
      { id: 'from-server', title: 'Server Said So' },
    ]);
  });

  it('falls back to the derived list when the payload carries an empty array', () => {
    const err = new ApiError(403, 'job_limit_reached', {
      plan_code: 'employer_free',
      active_job_limit: 1,
      active_jobs: 1,
      blocking_jobs: [],
    });

    expect(planLimitModel(err, [LANDSCAPE])!.blockingJobs).toEqual([
      { id: 'job-landscape', title: 'Landscape Maintenance Tech' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Case 9: subscription signage
// ---------------------------------------------------------------------------

describe('subscriptionSignage -- healthy plans show nothing', () => {
  it.each([
    ['null billing', null],
    ['undefined billing', undefined],
  ])('returns null for %s', (_label, value) => {
    expect(subscriptionSignage(value)).toBeNull();
  });

  it('returns null for a Pro plan with an active subscription', () => {
    expect(
      subscriptionSignage(
        billing({ planCode: EMPLOYER_PRO_PLAN_CODE, activeJobLimit: 10, templateLimit: 20, subscription: subscription() }),
        NOW,
      ),
    ).toBeNull();
  });

  it('returns null while a subscription is trialing', () => {
    expect(
      subscriptionSignage(
        billing({ planCode: EMPLOYER_PRO_PLAN_CODE, subscription: subscription({ status: 'trialing' }) }),
        NOW,
      ),
    ).toBeNull();
  });

  it('returns null for a Pro plan whose subscription is merely incomplete (not lapsed)', () => {
    expect(
      subscriptionSignage(
        billing({ planCode: EMPLOYER_PRO_PLAN_CODE, subscription: subscription({ status: 'incomplete' }) }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe('subscriptionSignage -- the free plan', () => {
  it('advertises the free limits when there is no subscription at all', () => {
    const signage = subscriptionSignage(billing({ activeJobLimit: 1, templateLimit: 1 }), NOW);

    expect(signage).not.toBeNull();
    expect(signage!.variant).toBe('free');
    expect(signage!.tone).toBe('info');
    expect(signage!.titleKey).toBe('signage.free_title');
    expect(signage!.bodyKey).toBe('signage.free_body');
    expect(signage!.bodyParams).toEqual({ jobLimit: 1, templateLimit: 1 });
    expect(signage!.statusKey).toBeNull();
    expect(signage!.ctaKey).toBe('signage.free_cta');
    expect(signage!.ctaHref).toBe('/employer/billing');
    expect(signage!.graceEndsAt).toBeNull();
  });

  it('still reads as free when a non-lapsed, non-active status is attached', () => {
    const signage = subscriptionSignage(
      billing({ subscription: subscription({ plan_code: 'employer_free', status: 'incomplete' }) }),
      NOW,
    );

    expect(signage!.variant).toBe('free');
    expect(signage!.bodyKey).toBe('signage.free_body');
  });
});

describe('subscriptionSignage -- a lapsed subscription', () => {
  it('keeps the copy grace-safe while past_due is still inside its grace window', () => {
    const signage = subscriptionSignage(
      billing({
        planCode: EMPLOYER_PRO_PLAN_CODE,
        subscription: subscription({ status: 'past_due', grace_ends_at: '2026-08-30T00:00:00.000Z' }),
      }),
      NOW,
    );

    expect(signage!.variant).toBe('lapsed');
    expect(signage!.tone).toBe('warning');
    expect(signage!.titleKey).toBe('signage.lapsed_title');
    // Entitlements are intact during grace -- the copy must not claim lost access.
    expect(signage!.bodyKey).toBe('signage.lapsed_body_grace');
    expect(signage!.ctaKey).toBe('signage.lapsed_cta_grace');
    expect(signage!.graceEndsAt).toBe('2026-08-30T00:00:00.000Z');
    expect(signage!.statusKey).toBe('status.past_due');
  });

  it('drops to the plain lapsed copy once the grace window has passed', () => {
    const signage = subscriptionSignage(
      billing({
        subscription: subscription({ status: 'past_due', grace_ends_at: '2026-08-01T00:00:00.000Z' }),
      }),
      NOW,
    );

    expect(signage!.variant).toBe('lapsed');
    expect(signage!.bodyKey).toBe('signage.lapsed_body');
    expect(signage!.ctaKey).toBe('signage.lapsed_cta');
    expect(signage!.graceEndsAt).toBeNull();
  });

  it('drops to the plain lapsed copy when past_due carries no grace date', () => {
    const signage = subscriptionSignage(
      billing({ subscription: subscription({ status: 'past_due', grace_ends_at: null }) }),
      NOW,
    );

    expect(signage!.bodyKey).toBe('signage.lapsed_body');
    expect(signage!.graceEndsAt).toBeNull();
  });

  it.each(['canceled', 'unpaid', 'paused', 'incomplete_expired'])(
    'treats %s as lapsed with no grace',
    (status) => {
      const signage = subscriptionSignage(
        billing({ subscription: subscription({ status, grace_ends_at: '2026-08-30T00:00:00.000Z' }) }),
        NOW,
      );

      expect(signage!.variant).toBe('lapsed');
      expect(signage!.tone).toBe('warning');
      expect(signage!.bodyKey).toBe('signage.lapsed_body');
      expect(signage!.ctaKey).toBe('signage.lapsed_cta');
      // Grace is a past_due-only concept; no other status gets the softer copy.
      expect(signage!.graceEndsAt).toBeNull();
      expect(signage!.statusKey).toBe(SUBSCRIPTION_STATUS_KEYS[status]);
    },
  );

  it('lets lapsed win over free: a lapsed Pro resolves to planCode employer_free on the backend', () => {
    const signage = subscriptionSignage(
      billing({ planCode: 'employer_free', subscription: subscription({ status: 'canceled' }) }),
      NOW,
    );

    expect(signage!.variant).toBe('lapsed');
    expect(signage!.bodyKey).toBe('signage.lapsed_body');
  });
});

describe('subscriptionSignage -- dismissKey', () => {
  it('changes when the status changes, so a dismissed banner re-shows', () => {
    const pastDue = subscriptionSignage(
      billing({ subscription: subscription({ status: 'past_due' }) }),
      NOW,
    );
    const canceled = subscriptionSignage(
      billing({ subscription: subscription({ status: 'canceled' }) }),
      NOW,
    );

    expect(pastDue!.dismissKey).toBe('jale.signage.lapsed.past_due');
    expect(canceled!.dismissKey).toBe('jale.signage.lapsed.canceled');
    expect(pastDue!.dismissKey).not.toBe(canceled!.dismissKey);
  });

  it('keys the free banner off the plan code', () => {
    expect(subscriptionSignage(billing(), NOW)!.dismissKey).toBe('jale.signage.free.employer_free');
  });
});

describe('SUBSCRIPTION_STATUS_KEYS', () => {
  // Moved verbatim out of the billing page, which supplies the `billing`
  // namespace via useTranslations -- so the values stay relative.
  it('maps every subscriptions.status enum value to its relative billing key', () => {
    expect(SUBSCRIPTION_STATUS_KEYS).toEqual({
      incomplete: 'status.incomplete',
      incomplete_expired: 'status.incomplete_expired',
      trialing: 'status.trialing',
      active: 'status.active',
      past_due: 'status.past_due',
      canceled: 'status.canceled',
      unpaid: 'status.unpaid',
      paused: 'status.paused',
    });
  });

  it('has a key for every lapsed status', () => {
    for (const status of LAPSED_SUBSCRIPTION_STATUSES) {
      expect(SUBSCRIPTION_STATUS_KEYS[status]).toBeTruthy();
    }
  });
});
