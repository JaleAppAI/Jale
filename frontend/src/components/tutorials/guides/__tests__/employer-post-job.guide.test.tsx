// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * The post-job guide (E2), every branch, over the REAL wizard (and the real
 * edit dialog, template editor and plan-limit dialog it also plays in), drawn
 * by the real GuideHost. Each test is one branch of the inventory's posting
 * flow (GUIDE-EDGE-CASES Part A).
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => '/employer/dashboard',
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));
vi.mock('@/lib/location-search', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/location-search')>()),
    queryLocations: vi.fn().mockResolvedValue([
        {
            label: 'Hayward, CA',
            cityKey: 'hayward-ca',
            zip: '94541',
            city: 'Hayward',
            state: 'CA',
            latitude: 37.67,
            longitude: -122.08,
            source: 'city',
        },
    ]),
}));
vi.mock('@/lib/api/payReference', () => ({ getPayReference: vi.fn().mockResolvedValue(null) }));

const listJobTemplates = vi.fn();
const getBilling = vi.fn();
const createJob = vi.fn();
const saveJobTemplate = vi.fn();
const updateJob = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    listJobTemplates: (...args: unknown[]) => listJobTemplates(...args),
    getBilling: (...args: unknown[]) => getBilling(...args),
    createJob: (...args: unknown[]) => createJob(...args),
    saveJobTemplate: (...args: unknown[]) => saveJobTemplate(...args),
    updateJob: (...args: unknown[]) => updateJob(...args),
}));

import { ApiError } from '@/lib/api/employer';
import type { Job, JobTemplate } from '@/lib/api/employer';
import { planLimitModel, activeJobsPreflightModel } from '@/lib/plan-limit';
import { PostJobModal } from '@/components/employer/PostJobModal';
import { EditJobModal } from '@/components/employer/EditJobModal';
import { TemplateEditModal } from '@/components/employer/TemplateEditModal';
import { PlanLimitDialog } from '@/components/employer/PlanLimitDialog';
import guide from '../employer-post-job';
import {
    action,
    counter,
    currentStep,
    fakeLayout,
    flush,
    mark,
    message,
    press,
    reach,
    renderWithGuide,
    type Locale,
} from './guide-kit';

const KEY = 'tutorial.employer_post_job.guide';

const withCity: JobTemplate = {
    id: 'tpl-city',
    name: 'Roofer (El Paso)',
    updated_at: '2026-09-01T00:00:00Z',
    payload: {
        title: 'Roofer',
        location: 'El Paso, TX',
        job_type: 'full-time',
        trade_category: 'concrete',
        city_key: 'el-paso-tx',
        city: 'El Paso',
        state: 'TX',
    },
};

const pro = {
    planCode: 'employer_pro', activeJobLimit: 10, templateLimit: 5, activeJobUsage: 0, subscription: null,
    display_price_minor: 2000, currency: 'usd', billing_interval: 'month',
};

const postedJob = { id: 'job-new-0001', title: 'Framer', location: 'Hayward, CA', status: 'active', shift_periods: [], public_listing_enabled: false };

beforeEach(() => {
    vi.clearAllMocks();
    fakeLayout();
    document.body.style.overflow = '';
    listJobTemplates.mockResolvedValue([]);
    getBilling.mockResolvedValue(pro);
    createJob.mockResolvedValue(postedJob);
    saveJobTemplate.mockResolvedValue({ id: 'tpl-new', name: 'Mine', payload: {}, updated_at: '2026-10-14T00:00:00Z' });
});

afterEach(() => {
    vi.restoreAllMocks();
});

function openWizard(locale: Locale = 'en') {
    return renderWithGuide(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />, { id: 'employer_post_job', locale });
}

const field = (name: string) => mark(name)?.querySelector<HTMLInputElement>('input, select, textarea') as HTMLInputElement;

function type(name: string, value: string) {
    act(() => {
        fireEvent.change(field(name), { target: { value } });
    });
}

async function pickCity() {
    const city = mark('post.city')?.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
    act(() => city.focus());
    fireEvent.change(city, { target: { value: 'Hay' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hayward, CA' }));
    await waitFor(() => expect(mark('post.city')?.querySelector('[data-picked]')).not.toBeNull());
    await flush();
}

async function wizardNext() {
    act(() => {
        fireEvent.click(mark('post.next') as HTMLElement);
    });
    await flush();
}

/** Start, then screen 1 with the trade picked from the list. */
async function throughScreenOne(trade = 'carpenter') {
    await reach('intro');
    await press('start');
    await reach('title');
    type('post.title', 'Framer');
    await press('next');
    await reach('city');
    await pickCity();
    await reach('trade');
    type('post.trade', trade);
    await flush();
}

/** Screen 2 with the defaults, Next pressed on each guide step. */
async function throughScreenTwo() {
    await reach('pay');
    await press('next');
    await reach('workers');
    await press('next');
    await reach('shifts');
    await press('next');
    await reach('times');
    await press('next');
    await reach('certifications');
    await press('next');
    await reach('next_details');
    await wizardNext();
}

async function toSubmit() {
    await throughScreenOne();
    await reach('next');
    await wizardNext();
    await throughScreenTwo();
    await reach('questions');
    await press('next');
    await reach('requirements');
    await press('next');
    await reach('template_save');
}

async function post() {
    act(() => {
        fireEvent.click(mark('post.submit') as HTMLElement);
    });
    await flush();
    await flush();
}

describe('the post-job guide: the main path through every screen', () => {
    it('walks screen 1, 2 and 3, Post and the posted screen, and completes on Got it', async () => {
        const view = openWizard();
        await throughScreenOne();
        await reach('next');
        expect(action('next')).toBeNull();
        await wizardNext();
        expect(mark('post.form')).toHaveAttribute('data-step', '2');
        await throughScreenTwo();
        await reach('questions');
        expect(mark('post.form')).toHaveAttribute('data-step', '3');
        await press('next');
        await reach('requirements');
        await press('next');
        await reach('template_save');
        await press('next');
        await reach('submit');
        expect(action('next')).toBeNull();
        await post();
        await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
        await reach('share');
        await press('next');
        await reach('done');
        expect(action('next')).toHaveTextContent(message('tutorial.common.got_it'));
        await press('next');
        expect(view.onDismiss).toHaveBeenCalledWith('completed');
        expect(screen.getByRole('heading', { name: message('employer_dashboard.job_posted.title') })).toBeInTheDocument();
    });

    it('counts only the steps that apply: no template picker, no Other box, no template name', async () => {
        openWizard();
        await reach('intro');
        await press('start');
        await reach('title');
        // The template picker, the city check, the Other box, the template
        // name, the Post answers and the other three places do not apply.
        const applying = guide.steps.filter((step) => !step.when || step.when()).length;
        expect(counter()).toBe(`Posting a job · 1 of ${applying}`);
        expect(applying).toBe(16);
    });

    it('keeps Next off on the title until there is a title', async () => {
        openWizard();
        await reach('intro');
        await press('start');
        await reach('title');
        expect(action('next')).toBeDisabled();
        type('post.title', '   ');
        await flush();
        expect(action('next')).toBeDisabled();
        type('post.title', 'Framer');
        await flush();
        expect(action('next')).not.toBeDisabled();
    });

    it('does not move on from the city for typed text: only a pick from the list counts', async () => {
        openWizard();
        await reach('intro');
        await press('start');
        await reach('title');
        type('post.title', 'Framer');
        await press('next');
        await reach('city');
        const city = mark('post.city')?.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
        act(() => city.focus());
        fireEvent.change(city, { target: { value: 'Hayward, CA' } });
        await flush(200);
        expect(currentStep()).toBe('city');
        expect(action('next')).toBeNull();
        fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hayward, CA' }));
        await reach('trade');
    });

    it('completes the Next step only when the wizard reaches screen 2, not on a refused press', async () => {
        openWizard();
        await throughScreenOne();
        await reach('next');
        // Empty the title under the guide: the wizard refuses Next.
        type('post.title', '');
        await wizardNext();
        expect(mark('post.form')).toHaveAttribute('data-step', '1');
        expect(currentStep()).toBe('next');
    });
});

describe('the post-job guide: branches on screen 1', () => {
    it('adds the Other box step when Other is picked, and the counter grows by one', async () => {
        openWizard();
        await reach('intro');
        await press('start');
        await reach('title');
        const before = counter();
        type('post.title', 'Welding lead');
        await press('next');
        await reach('city');
        await pickCity();
        await reach('trade');
        type('post.trade', 'other');
        await reach('trade_other');
        expect(before).toMatch(/1 of 16$/);
        expect(counter()).toMatch(/4 of 17$/);
        expect(action('next')).toBeDisabled();
        type('post.trade_other', 'Welder');
        await flush();
        await press('next');
        await reach('next');
    });

    it('offers Start from a template only when templates exist, then asks to check the template’s city', async () => {
        listJobTemplates.mockResolvedValue([withCity]);
        openWizard();
        await reach('intro');
        await waitFor(() => expect(mark('post.template')).not.toBeNull());
        await press('start');
        await reach('template');
        const select = field('post.template') as unknown as HTMLSelectElement;
        act(() => {
            fireEvent.change(select, { target: { value: withCity.id } });
        });
        await flush();
        await press('next');
        await reach('title');
        expect(field('post.title').value).toBe('Roofer');
        await press('next');
        // The template's city: "Check the city" instead of "Pick the city".
        await reach('city_check');
        expect(mark('post.city_check')).not.toBeNull();
        expect(action('next')).not.toBeDisabled();
        await press('next');
        await reach('trade');
    });

    it('skips the template step when there are no templates', async () => {
        openWizard();
        await reach('intro');
        await press('start');
        await reach('title');
        expect(mark('post.template')).toBeNull();
    });
});

describe('the post-job guide: branches on screen 2', () => {
    it('keeps Next off on pay while Pay Min is more than Pay Max', async () => {
        openWizard();
        await throughScreenOne();
        await reach('next');
        await wizardNext();
        await reach('pay');
        const [min, max] = Array.from(mark('post.pay')?.querySelectorAll('input') ?? []);
        act(() => {
            fireEvent.change(min, { target: { value: '30' } });
            fireEvent.change(max, { target: { value: '20' } });
        });
        await flush();
        expect(action('next')).toBeDisabled();
        act(() => {
            fireEvent.change(max, { target: { value: '' } });
        });
        await flush();
        expect(action('next')).not.toBeDisabled();
    });

    it('keeps Next off on the workers until it is 1 or more', async () => {
        openWizard();
        await throughScreenOne();
        await reach('next');
        await wizardNext();
        await reach('pay');
        await press('next');
        await reach('workers');
        type('post.workers', '0');
        await flush();
        expect(action('next')).toBeDisabled();
        type('post.workers', '2');
        await flush();
        expect(action('next')).not.toBeDisabled();
    });

    it('keeps Next off while only one shift time is filled', async () => {
        openWizard();
        await throughScreenOne();
        await reach('next');
        await wizardNext();
        for (const id of ['pay', 'workers', 'shifts']) {
            await reach(id);
            await press('next');
        }
        await reach('times');
        const [start, end] = Array.from(mark('post.times')?.querySelectorAll('input') ?? []);
        act(() => {
            fireEvent.change(start, { target: { value: '07:00' } });
        });
        await flush();
        expect(action('next')).toBeDisabled();
        expect(callout()?.querySelector('[data-spotlight-wait]')).toHaveTextContent(message(`${KEY}.steps.times.wait`));
        act(() => {
            fireEvent.change(end, { target: { value: '15:30' } });
        });
        await flush();
        expect(action('next')).not.toBeDisabled();
    });
});

function callout() {
    return document.querySelector('[data-spotlight] [role="dialog"]');
}

describe('the post-job guide: branches on screen 3 and at Post', () => {
    it('keeps Next off while an added question is empty', async () => {
        openWizard();
        await toSubmit();
        // Back to the questions.
        await press('back');
        await press('back');
        await reach('questions');
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('job_requirements.prompts.add') }));
        });
        await flush();
        expect(action('next')).toBeDisabled();
        act(() => {
            fireEvent.change(mark('post.questions')?.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'What tools do you bring?' } });
        });
        await flush();
        expect(action('next')).not.toBeDisabled();
    });

    it('asks for a template name once Save as template is ticked, with Next off until one is typed', async () => {
        openWizard();
        await toSubmit();
        act(() => {
            fireEvent.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
        });
        await flush();
        await press('next');
        await reach('template_name');
        expect(action('next')).toBeDisabled();
        type('post.template_name', 'Framer, Hayward');
        await flush();
        await press('next');
        await reach('submit');
        await post();
        await waitFor(() => expect(saveJobTemplate).toHaveBeenCalledTimes(1));
        await reach('share');
    });

    it('explains a server error, and posts again from the same step', async () => {
        createJob.mockRejectedValueOnce(new ApiError(500, 'internal', {}));
        openWizard();
        await toSubmit();
        await press('next');
        await reach('submit');
        await post();
        await reach('post_error');
        expect(mark('post.error')).not.toBeNull();
        await post();
        await waitFor(() => expect(createJob).toHaveBeenCalledTimes(2));
        await reach('share');
    });

    it('explains the plan limit refused at Post and ends there', async () => {
        createJob.mockRejectedValue(new ApiError(403, 'job_limit_reached', { active_job_limit: 1, active_job_usage: 1 }));
        const view = openWizard();
        await toSubmit();
        await press('next');
        await reach('submit');
        await post();
        await reach('job_limit');
        expect(action('next')).toHaveTextContent(message('tutorial.common.got_it'));
        await press('next');
        expect(view.onDismiss).toHaveBeenCalledWith('completed');
    });

    it('asks for another name when the template name is taken, then posts', async () => {
        listJobTemplates.mockResolvedValue([withCity]);
        openWizard();
        await waitFor(() => expect(mark('post.template')).not.toBeNull());
        await reach('intro');
        await press('start');
        await reach('template');
        await press('next');
        await reach('title');
        type('post.title', 'Framer');
        await press('next');
        await reach('city');
        await pickCity();
        await reach('trade');
        type('post.trade', 'carpenter');
        await reach('next');
        await wizardNext();
        await throughScreenTwo();
        for (const id of ['questions', 'requirements']) {
            await reach(id);
            await press('next');
        }
        await reach('template_save');
        act(() => {
            fireEvent.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
        });
        await flush();
        await press('next');
        await reach('template_name');
        type('post.template_name', withCity.name);
        await flush();
        await press('next');
        await reach('submit');
        await post();
        await reach('template_taken');
        expect(action('next')).toBeDisabled();
        type('post.template_name', 'Framer, Hayward');
        await flush();
        expect(mark('post.template_taken')).toBeNull();
        await press('next');
        await reach('post_again');
        await post();
        await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
        await reach('share');
    });

    it('points at Post without saving template when the template cap is reached', async () => {
        listJobTemplates.mockResolvedValue([withCity]);
        getBilling.mockResolvedValue({ ...pro, templateLimit: 1 });
        openWizard();
        await waitFor(() => expect(mark('post.template')).not.toBeNull());
        await reach('intro');
        await press('start');
        await reach('template');
        await press('next');
        await reach('title');
        type('post.title', 'Framer');
        await press('next');
        await reach('city');
        await pickCity();
        await reach('trade');
        type('post.trade', 'carpenter');
        await reach('next');
        await wizardNext();
        await throughScreenTwo();
        for (const id of ['questions', 'requirements']) {
            await reach(id);
            await press('next');
        }
        await reach('template_save');
        act(() => {
            fireEvent.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
        });
        await flush();
        await press('next');
        await reach('template_name');
        type('post.template_name', 'Framer, Hayward');
        await flush();
        await press('next');
        await reach('submit');
        await post();
        await reach('template_limit');
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.modal.post_without_template') }));
        });
        await flush();
        await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
        expect(saveJobTemplate).not.toHaveBeenCalled();
        await reach('share');
    });

    it('names the note when the posted job’s template was not saved', async () => {
        saveJobTemplate.mockRejectedValue(new ApiError(409, 'template_name_taken', {}));
        openWizard();
        await toSubmit();
        act(() => {
            fireEvent.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
        });
        await flush();
        await press('next');
        await reach('template_name');
        type('post.template_name', 'Framer, Hayward');
        await flush();
        await press('next');
        await reach('submit');
        await post();
        await reach('template_not_saved');
        expect(mark('post.template_not_saved')).toHaveTextContent(message('employer_dashboard.jobs.template_not_saved_name_taken'));
        await press('next');
        await reach('share');
    });
});

const job = (over: Partial<Job> = {}) =>
    ({
        id: 'job-1', title: 'Concrete Finisher', location: 'El Paso, TX', city_key: 'el-paso-tx', city: 'El Paso', state: 'TX',
        state_region: 'TX', status: 'active', applicant_count: 0, hired_count: 0, open_count: 3, number_of_workers_needed: 3,
        trade_category: 'concrete', job_type: 'full-time', pay_min: 22, pay_max: 28, pay_interval: 'hour', shift_periods: [],
        work_days: [], language_preference: ['any'], certifications: [], certification_requirements: [], pre_application_prompts: [],
        required_docs: [], optional_docs: [], required_fields: [], optional_fields: [], created_at: '2026-09-01T00:00:00Z',
        ...over,
    }) as unknown as Job;

describe('the post-job guide in the edit dialog', () => {
    function openEdit(over: Partial<Job> = {}) {
        return renderWithGuide(<EditJobModal open job={job(over)} onClose={vi.fn()} onJobUpdated={vi.fn()} />, {
            id: 'employer_post_job',
            mode: 'always',
        });
    }

    it('shows the one-form layout and Save changes, with nothing about locks before anyone applies', async () => {
        const view = openEdit();
        await reach('intro');
        await press('start');
        await reach('edit_form');
        expect(counter()).toMatch(/1 of 2$/);
        await press('next');
        await reach('edit_save');
        await press('next');
        expect(view.onDismiss).toHaveBeenCalledWith('completed');
    });

    it('says why the questions are locked once someone applied, and the hired floor on workers', async () => {
        openEdit({ applicant_count: 3, hired_count: 2 } as Partial<Job>);
        await reach('intro');
        await press('start');
        await reach('edit_form');
        expect(counter()).toMatch(/1 of 4$/);
        await press('next');
        await reach('edit_locked');
        expect(mark('edit.questions')).toHaveAttribute('data-locked');
        await press('next');
        await reach('edit_workers');
        type('edit.workers', '1');
        await flush();
        expect(action('next')).toBeDisabled();
        type('edit.workers', '2');
        await flush();
        await press('next');
        await reach('edit_save');
    });
});

describe('the post-job guide in the template editor', () => {
    it('asks for the name first, then the job, then Save template', async () => {
        renderWithGuide(<TemplateEditModal open template={null} onClose={vi.fn()} onSaved={vi.fn()} />, {
            id: 'employer_post_job',
            mode: 'always',
        });
        await reach('intro');
        await press('start');
        await reach('tpl_name');
        expect(action('next')).toBeDisabled();
        type('tpl.name', 'Roofer');
        await flush();
        await press('next');
        await reach('tpl_form');
        await press('next');
        await reach('tpl_save');
        expect(action('next')).toHaveTextContent(message('tutorial.common.got_it'));
    });
});

describe('the post-job guide over the plan-limit dialog', () => {
    it('explains the limit and the dialog’s ways out, instead of the wizard', async () => {
        const model = activeJobsPreflightModel(
            { ...pro, planCode: 'employer_free', activeJobLimit: 1 } as never,
            1,
            [job()],
        );
        expect(model).not.toBeNull();
        const view = renderWithGuide(<PlanLimitDialog open model={model} onClose={vi.fn()} />, {
            id: 'employer_post_job',
            mode: 'replay',
        });
        await reach('intro');
        await press('start');
        await reach('limit');
        expect(counter()).toMatch(/1 of 2$/);
        await press('next');
        await reach('limit_actions');
        await press('next');
        expect(view.onDismiss).toHaveBeenCalledWith('completed');
    });

    it('is the same model the wizard’s late refusal shows', () => {
        expect(planLimitModel(new ApiError(403, 'job_limit_reached', { active_job_limit: 1 }))).not.toBeNull();
    });
});

describe('the post-job guide’s copy', () => {
    it.each(['en', 'es'] as const)('names the wizard’s own Post Job label, not the dashboard’s, in %s', (locale) => {
        const label = message('employer_dashboard.post_job_docs.submit', locale);
        expect(message(`${KEY}.steps.submit.body`, locale)).toContain(label);
        expect(message(`${KEY}.steps.post_again.body`, locale)).toContain(label);
        const dashboardLabel = message('employer_dashboard.hero.primary_cta', locale);
        if (dashboardLabel !== label) expect(message(`${KEY}.steps.submit.body`, locale)).not.toContain(dashboardLabel);
    });

    it('names the other real labels it points at, in both languages', () => {
        const pairs: Array<[string, string]> = [
            ['steps.template_limit.body', 'employer_dashboard.modal.post_without_template'],
            ['steps.share.body', 'employer_dashboard.job_posted.turn_on'],
            ['steps.done.body', 'employer_dashboard.job_posted.back'],
            ['steps.edit_save.body', 'employer_dashboard.modal.edit_save'],
            ['steps.tpl_save.body', 'employer_dashboard.templates.save'],
            ['steps.template_save.body', 'employer_dashboard.modal.template_save_toggle'],
            ['steps.limit_actions.body', 'billing.limit_dialog.cta_pause_job'],
            ['steps.limit_actions.body', 'billing.limit_dialog.cta_upgrade'],
            ['steps.limit_actions.body', 'billing.limit_dialog.dismiss'],
        ];
        for (const locale of ['en', 'es'] as const) {
            for (const [step, label] of pairs) expect(message(`${KEY}.${step}`, locale), `${locale} ${step}`).toContain(message(label, locale));
        }
    });

    it('speaks usted in Spanish', () => {
        for (const id of ['title', 'submit', 'post_error', 'share', 'edit_save', 'tpl_save']) {
            const body = message(`${KEY}.steps.${id}.body`, 'es');
            expect(body, id).not.toMatch(/\b(toca|escribe|elige|publica|tu|tus)\b/i);
        }
    });
});
