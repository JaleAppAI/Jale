// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { createTranslator } from 'next-intl';
import type { EmployerBilling, JobTemplate } from '@/lib/api/employer';
import { catalogues, message, renderIntl } from '@/components/employer/__tests__/render-intl';

/*
 * Phase 3 (Task 14): the template limit is the company's, so the count held
 * against `templateLimit` is `billing.templateUsage` (company-wide) when the
 * API sends it, kept live against this page's list so a delete still frees
 * its slot at once. Same stubs as meter.test.tsx.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

// A STABLE `handleLegalWall`, as the real hook's is (`useCallback`): the page's
// list fetch depends on it, and a fresh function per render would re-list
// after every state change -- including right after a delete.
const { handleLegalWall } = vi.hoisted(() => ({
    handleLegalWall: (err: unknown) => {
        throw err;
    },
}));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ handleLegalWall }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/employer/TemplateEditModal', () => ({
    TemplateEditModal: () => null,
}));

const listJobTemplates = vi.fn();
const getBilling = vi.fn();
const deleteJobTemplate = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    listJobTemplates: (...args: unknown[]) => listJobTemplates(...args),
    getBilling: (...args: unknown[]) => getBilling(...args),
    deleteJobTemplate: (...args: unknown[]) => deleteJobTemplate(...args),
}));

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { PostJobProvider } from '@/contexts/PostJobContext';
import { ApiError } from '@/lib/api/errors';
import { planLimitModel } from '@/lib/plan-limit';
import EmployerTemplatesPage from '../page';

type CreateTranslatorOptions = Parameters<typeof createTranslator>[0];

/** A `billing.*` key formatted as the page formats it (ICU plurals included). */
function billingText(key: string, values?: Record<string, number>): string {
    const t = createTranslator({
        locale: 'en',
        messages: catalogues.en,
        namespace: 'billing',
    } as unknown as CreateTranslatorOptions) as unknown as (k: string, v?: Record<string, number>) => string;
    return t(key, values);
}

async function deleteFirst() {
    fireEvent.click(screen.getAllByRole('button', { name: message('employer_dashboard.templates.delete_confirm') })[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: message('employer_dashboard.templates.delete_confirm') }));
}

function template(id: string): JobTemplate {
    return {
        id,
        name: `Template ${id}`,
        payload: { title: 'Drywall Finisher', location: 'Austin, TX' } as JobTemplate['payload'],
        updated_at: '2026-09-01T12:00:00.000Z',
    };
}

function billing(templateLimit: number, templateUsage?: number): EmployerBilling {
    return { templateLimit, templateUsage } as EmployerBilling;
}

function renderPage() {
    return renderIntl(
        <PostJobProvider>
            <EmployerTemplatesPage />
        </PostJobProvider>,
    );
}

const newButton = () => screen.getAllByRole('button', { name: message('employer_dashboard.templates.new') })[0];

beforeEach(() => {
    listJobTemplates.mockReset();
    getBilling.mockReset();
    deleteJobTemplate.mockReset();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('employer templates — the company count', () => {
    it('the limit check uses billing.templateUsage when present', async () => {
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue(billing(3, 3));

        renderPage();

        await waitFor(() => expect(screen.getByText('3 saved · 3 allowed on your plan')).toBeInTheDocument());
        expect(newButton()).toBeDisabled();
        expect(screen.getByText(message('employer_dashboard.templates.limit_note'))).toBeInTheDocument();
    });

    it('a delete still frees its slot at once', async () => {
        listJobTemplates.mockResolvedValue([template('a'), template('b')]);
        getBilling.mockResolvedValue(billing(3, 3));
        deleteJobTemplate.mockResolvedValue(undefined);

        renderPage();
        await waitFor(() => expect(screen.getByText('3 saved · 3 allowed on your plan')).toBeInTheDocument());
        expect(newButton()).toBeDisabled();

        fireEvent.click(screen.getAllByRole('button', { name: message('employer_dashboard.templates.delete_confirm') })[0]);
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: message('employer_dashboard.templates.delete_confirm') }));

        await waitFor(() => expect(deleteJobTemplate).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByText('2 saved · 3 allowed on your plan')).toBeInTheDocument());
        expect(newButton()).not.toBeDisabled();
    });

    it('without templateUsage the list is the count, as before', async () => {
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue(billing(3));

        renderPage();

        await waitFor(() => expect(screen.getByText('1 saved · 3 allowed on your plan')).toBeInTheDocument());
        expect(newButton()).not.toBeDisabled();
    });

    it('a foreman at the limit reads the save dialog\'s own body, with no Billing link', async () => {
        listJobTemplates.mockResolvedValue([template('a'), template('b')]);
        getBilling.mockResolvedValue({ ...billing(2, 2), role: 'foreman', planCode: 'employer_free' });

        renderPage();

        // The key the save dialog's model hands this foreman for the same limit.
        const modal = planLimitModel(
            new ApiError(403, 'template_limit_reached', { template_limit: 2, plan_code: 'employer_free' }),
            null,
            { role: 'foreman', planCode: 'employer_free' },
        );
        expect(modal?.bodyKey).toBe('limit_dialog.body_templates_foreman');
        const text = billingText(modal!.bodyKey, modal!.bodyParams);
        expect(text).toBe("Your company's plan allows 2 saved templates. Delete one you created, or ask your owner to free a slot.");
        await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument());
        expect(screen.queryByText(message('billing.limit_dialog.foreman_body'))).toBeNull();
        expect(screen.queryByText(message('employer_dashboard.templates.limit_note'))).toBeNull();
        expect(document.querySelector('a[href="/employer/billing"]')).toBeNull();
    });

    it('a Pro owner at the limit is told a delete frees a slot (not "pause a job"), with no Billing link', async () => {
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue({ ...billing(1, 1), role: 'owner', planCode: 'employer_pro' });

        renderPage();

        await waitFor(() => expect(screen.getByText(message('billing.limit_dialog.hint_templates'))).toBeInTheDocument());
        expect(screen.queryByText(message('billing.limit_dialog.pro_owner_hint'))).toBeNull();
        expect(screen.queryByText(message('employer_dashboard.templates.limit_note'))).toBeNull();
        expect(document.querySelector('a[href="/employer/billing"]')).toBeNull();
    });

    it('a Free owner at the limit keeps the note and its Billing link', async () => {
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue({ ...billing(1, 1), role: 'owner', planCode: 'employer_free' });

        renderPage();

        await waitFor(() => expect(screen.getByText(message('employer_dashboard.templates.limit_note'))).toBeInTheDocument());
        expect(document.querySelector('a[href="/employer/billing"]')).not.toBeNull();
    });

    it('flag off: a foreman row still gets Phase 2\'s note and link', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue({ ...billing(1, 1), role: 'foreman', planCode: 'employer_pro' });

        renderPage();

        await waitFor(() => expect(screen.getByText(message('employer_dashboard.templates.limit_note'))).toBeInTheDocument());
        expect(document.querySelector('a[href="/employer/billing"]')).not.toBeNull();
    });

    it('a delete refused 403 forbidden (a template someone else created) says so', async () => {
        listJobTemplates.mockResolvedValue([template('a'), template('b')]);
        getBilling.mockResolvedValue({ ...billing(3, 2), role: 'foreman', planCode: 'employer_free' });
        deleteJobTemplate.mockRejectedValue(new ApiError(403, 'forbidden'));

        renderPage();
        await waitFor(() => expect(screen.getByText('2 saved · 3 allowed on your plan')).toBeInTheDocument());
        await deleteFirst();

        expect(await screen.findByText(message('employer_dashboard.templates.delete_forbidden'))).toBeInTheDocument();
        expect(screen.queryByText(message('employer_dashboard.templates.delete_error'))).toBeNull();
        expect(screen.getByText('2 saved · 3 allowed on your plan')).toBeInTheDocument();
    });

    it('any other delete failure keeps delete_error', async () => {
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue(billing(3, 1));
        deleteJobTemplate.mockRejectedValue(new ApiError(500, 'internal_error'));

        renderPage();
        await waitFor(() => expect(screen.getByText('1 saved · 3 allowed on your plan')).toBeInTheDocument());
        await deleteFirst();

        expect(await screen.findByText(message('employer_dashboard.templates.delete_error'))).toBeInTheDocument();
        expect(screen.queryByText(message('employer_dashboard.templates.delete_forbidden'))).toBeNull();
    });

    it('flag off: a 403 forbidden delete keeps Phase 2\'s delete_error', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue(billing(3));
        deleteJobTemplate.mockRejectedValue(new ApiError(403, 'forbidden'));

        renderPage();
        await waitFor(() => expect(screen.getByText('1 saved · 3 allowed on your plan')).toBeInTheDocument());
        await deleteFirst();

        expect(await screen.findByText(message('employer_dashboard.templates.delete_error'))).toBeInTheDocument();
        expect(screen.queryByText(message('employer_dashboard.templates.delete_forbidden'))).toBeNull();
    });

    it('flag off: the list is the count, exactly Phase 2', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        listJobTemplates.mockResolvedValue([template('a')]);
        getBilling.mockResolvedValue(billing(3, 3));

        renderPage();

        await waitFor(() => expect(screen.getByText('1 saved · 3 allowed on your plan')).toBeInTheDocument());
        expect(newButton()).not.toBeDisabled();
    });
});
