import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeJobsPreflightModel, companyTemplateCount, planLimitModel, upgradeOffered } from '../plan-limit';
import { ApiError } from '../api/errors';
import { EMPLOYER_PRO_PLAN_CODE } from '../api/employer';
import type { EmployerBilling } from '../api/employer';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/*
 * Phase 3 (Task 14): who is reading the plan-limit dialog changes what it may
 * offer. A foreman cannot upgrade (only the owner pays), and an owner already
 * on Pro has nothing to upgrade to -- for both, "Upgrade plan" is a dead end.
 */

const jobLimit = () => new ApiError(403, 'job_limit_reached', { active_job_limit: 3, active_jobs: 3, plan_code: 'employer_free' });
const templateLimit = () => new ApiError(403, 'template_limit_reached', { template_limit: 1, plan_code: 'employer_free' });

function ctaKinds(model: ReturnType<typeof planLimitModel>): string[] {
    return (model?.ctas ?? []).map((cta) => cta.kind);
}

describe('planLimitModel(…, { role, planCode })', () => {
    it('foreman: no upgrade CTA and the ask-your-owner body', () => {
        const jobs = planLimitModel(jobLimit(), null, { role: 'foreman', planCode: 'employer_free' });
        expect(jobs?.bodyKey).toBe('limit_dialog.foreman_body');
        expect(ctaKinds(jobs)).toEqual(['pause_job']);
        // The self-service hint still holds: a foreman can pause their own job.
        expect(jobs?.hintKey).toBe('limit_dialog.hint_jobs');

        const templates = planLimitModel(templateLimit(), null, { role: 'foreman', planCode: EMPLOYER_PRO_PLAN_CODE });
        expect(templates?.bodyKey).toBe('limit_dialog.foreman_body');
        expect(ctaKinds(templates)).toEqual(['manage_templates']);
    });

    it('Pro owner: no upgrade CTA and the pro hint', () => {
        const jobs = planLimitModel(jobLimit(), null, { role: 'owner', planCode: EMPLOYER_PRO_PLAN_CODE });
        expect(jobs?.hintKey).toBe('limit_dialog.pro_owner_hint');
        expect(jobs?.bodyKey).toBe('limit_dialog.body_jobs');
        expect(ctaKinds(jobs)).toEqual(['pause_job']);

        const templates = planLimitModel(templateLimit(), null, { role: 'owner', planCode: EMPLOYER_PRO_PLAN_CODE });
        expect(templates?.hintKey).toBe('limit_dialog.pro_owner_hint');
        expect(ctaKinds(templates)).toEqual(['manage_templates']);

        // An API without a role predates companies: that login is the owner.
        const noRole = planLimitModel(jobLimit(), null, { role: null, planCode: EMPLOYER_PRO_PLAN_CODE });
        expect(noRole?.hintKey).toBe('limit_dialog.pro_owner_hint');
        expect(ctaKinds(noRole)).toEqual(['pause_job']);
    });

    it('Free owner: unchanged', () => {
        const without = planLimitModel(jobLimit());
        expect(planLimitModel(jobLimit(), null, { role: 'owner', planCode: 'employer_free' })).toEqual(without);
        expect(ctaKinds(without)).toEqual(['pause_job', 'upgrade']);
        expect(without?.bodyKey).toBe('limit_dialog.body_jobs');
        expect(without?.hintKey).toBe('limit_dialog.hint_jobs');
        expect(planLimitModel(templateLimit(), null, { role: 'owner', planCode: 'employer_free' }))
            .toEqual(planLimitModel(templateLimit()));
    });

    it('Pro owner: no body says "upgrade" where the catalogue has an alternative', () => {
        const pro = { role: 'owner', planCode: EMPLOYER_PRO_PLAN_CODE } as const;
        // Preflight ("…or upgrade your plan.") and zero ("Upgrade to publish…") become body_jobs.
        expect(activeJobsPreflightModel({ planCode: EMPLOYER_PRO_PLAN_CODE, activeJobLimit: 2 }, 2, null, pro)?.bodyKey)
            .toBe('limit_dialog.body_jobs');
        const zero = new ApiError(403, 'job_limit_reached', { active_job_limit: 0, active_jobs: 0 });
        expect(planLimitModel(zero, null, pro)?.bodyKey).toBe('limit_dialog.body_jobs');
        expect(activeJobsPreflightModel({ planCode: EMPLOYER_PRO_PLAN_CODE, activeJobLimit: 0 }, 0, null, pro)?.bodyKey)
            .toBe('limit_dialog.body_jobs');
        // The bodies that are kept: zero templates never mentions upgrading;
        // body_templates has no upgrade-free twin yet (needs a string).
        const zeroTemplates = new ApiError(403, 'template_limit_reached', { template_limit: 0 });
        expect(planLimitModel(zeroTemplates, null, pro)?.bodyKey).toBe('limit_dialog.body_templates_zero');
        expect(planLimitModel(templateLimit(), null, pro)?.bodyKey).toBe('limit_dialog.body_templates');
        for (const tree of [en, es]) {
            expect(tree.billing.limit_dialog.body_jobs.toLowerCase()).not.toMatch(/upgrade|mejore/);
            expect(tree.billing.limit_dialog.body_templates_zero.toLowerCase()).not.toMatch(/upgrade|mejore/);
        }
    });

    it('a Free owner keeps the preflight body with its upgrade', () => {
        expect(activeJobsPreflightModel({ planCode: 'employer_free', activeJobLimit: 1 }, 1, null, { role: 'owner', planCode: 'employer_free' })?.bodyKey)
            .toBe('limit_dialog.body_jobs_preflight');
    });

    it('an owner whose plan is unknown to the caller reads it off the 403', () => {
        const proLimit = new ApiError(403, 'job_limit_reached', { active_job_limit: 10, active_jobs: 10, plan_code: EMPLOYER_PRO_PLAN_CODE });
        const model = planLimitModel(proLimit, null, { role: 'owner', planCode: null });
        expect(model?.hintKey).toBe('limit_dialog.pro_owner_hint');
        expect(ctaKinds(model)).toEqual(['pause_job']);
        // Without an audience (flag off), Phase 2's model even on Pro.
        expect(ctaKinds(planLimitModel(proLimit))).toEqual(['pause_job', 'upgrade']);
    });

    it('anything that is not a plan limit is still null', () => {
        expect(planLimitModel(new ApiError(403, 'owner_required'), null, { role: 'foreman' })).toBeNull();
    });

    it('the keys it hands out exist in both catalogues', () => {
        for (const tree of [en, es]) {
            expect(typeof tree.billing.limit_dialog.foreman_body).toBe('string');
            expect(typeof tree.billing.limit_dialog.pro_owner_hint).toBe('string');
        }
    });
});

describe('activeJobsPreflightModel and the audience', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    const full = (over: Partial<EmployerBilling> = {}) => ({
        planCode: 'employer_free',
        activeJobLimit: 1,
        otherMembersActiveJobs: 0,
        ...over,
    });

    it('takes an explicit audience', () => {
        const model = activeJobsPreflightModel(full(), 1, null, { role: 'foreman', planCode: 'employer_free' });
        expect(model?.bodyKey).toBe('limit_dialog.foreman_body');
        expect(ctaKinds(model)).toEqual(['pause_job']);
    });

    it('flag on: reads the audience off billing (role, planCode) when none is passed', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
        expect(activeJobsPreflightModel(full({ role: 'foreman' }), 1)?.bodyKey).toBe('limit_dialog.foreman_body');
        expect(activeJobsPreflightModel(full({ role: 'owner', planCode: EMPLOYER_PRO_PLAN_CODE }), 1)?.hintKey)
            .toBe('limit_dialog.pro_owner_hint');
    });

    it('flag off: Phase 2 copy whatever billing says', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        const model = activeJobsPreflightModel(full({ role: 'owner', planCode: EMPLOYER_PRO_PLAN_CODE }), 1);
        expect(model?.hintKey).toBe('limit_dialog.hint_jobs');
        expect(ctaKinds(model)).toEqual(['pause_job', 'upgrade']);
    });
});

describe('companyTemplateCount', () => {
    it('is the company figure from billing when there is no live list to add to', () => {
        expect(companyTemplateCount({ templateUsage: 5 }, null)).toBe(5);
        expect(companyTemplateCount({ templateUsage: 0 }, null)).toBe(0);
    });

    it('is the list count when billing has no usable figure', () => {
        expect(companyTemplateCount(null, 2)).toBe(2);
        expect(companyTemplateCount({}, 2)).toBe(2);
        expect(companyTemplateCount({ templateUsage: -1 }, 2)).toBe(2);
        expect(companyTemplateCount({ templateUsage: 1.5 }, 2)).toBe(2);
        expect(companyTemplateCount(undefined, null)).toBeNull();
    });

    it('follows the live list from the moment billing was read', () => {
        // Billing said 5 when the list held 2: three are not in this list.
        expect(companyTemplateCount({ templateUsage: 5 }, 2, 2)).toBe(5);
        // One deleted since: 4. One saved since: 6.
        expect(companyTemplateCount({ templateUsage: 5 }, 1, 2)).toBe(4);
        expect(companyTemplateCount({ templateUsage: 5 }, 3, 2)).toBe(6);
        // A list that already shows the whole company moves one for one.
        expect(companyTemplateCount({ templateUsage: 2 }, 1, 2)).toBe(1);
    });
});

describe('upgradeOffered', () => {
    it('is Phase 2 (always) without an audience', () => {
        expect(upgradeOffered(undefined)).toBe(true);
    });

    it('is never offered to a foreman, nor to an owner already on Pro', () => {
        expect(upgradeOffered({ role: 'foreman', planCode: 'employer_free' })).toBe(false);
        expect(upgradeOffered({ role: 'foreman', planCode: null })).toBe(false);
        expect(upgradeOffered({ role: 'owner', planCode: EMPLOYER_PRO_PLAN_CODE })).toBe(false);
        expect(upgradeOffered({ role: null, planCode: EMPLOYER_PRO_PLAN_CODE })).toBe(false);
    });

    it('is offered to a Free owner, and when the plan is unknown', () => {
        expect(upgradeOffered({ role: 'owner', planCode: 'employer_free' })).toBe(true);
        expect(upgradeOffered({ role: null, planCode: null })).toBe(true);
    });
});
