// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import type { EmployerBilling, JobTemplate } from '@/lib/api/employer';
import { renderIntl } from '@/components/employer/__tests__/render-intl';

/*
 * The meter over the templates table, and only the meter.
 *
 * "{count} of {limit} templates" read as a fraction of a whole -- at zero it
 * said "0 of 3 templates", which states a quantity of templates that does not
 * exist and puts the emphasis on the plan's ceiling rather than on the fact
 * that the employer has nothing saved yet. The two facts are separated now:
 * what you have, then what your plan allows.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The editor is a three-step form with its own fetches; whether it OPENS is
// not what this suite asserts.
vi.mock('@/components/employer/TemplateEditModal', () => ({
    TemplateEditModal: () => null,
}));

const listJobTemplates = vi.fn();
const getBilling = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    listJobTemplates: (...args: unknown[]) => listJobTemplates(...args),
    getBilling: (...args: unknown[]) => getBilling(...args),
    deleteJobTemplate: vi.fn(),
}));

// Below every `vi.mock` on purpose (they hoist).
import EmployerTemplatesPage from '../page';

function template(id: string): JobTemplate {
    return {
        id,
        name: `Template ${id}`,
        payload: { title: 'Drywall Finisher', location: 'Austin, TX' } as JobTemplate['payload'],
        updated_at: '2026-09-01T12:00:00.000Z',
    };
}

/** Only `templateLimit` is read by the meter; the rest of the plan is noise. */
function billing(templateLimit: number): EmployerBilling {
    return { templateLimit } as EmployerBilling;
}

beforeEach(() => {
    listJobTemplates.mockReset();
    getBilling.mockReset();
});

describe('employer templates — the meter', () => {
    it('names the empty state instead of counting zero templates', async () => {
        listJobTemplates.mockResolvedValue([]);
        getBilling.mockResolvedValue(billing(3));

        renderIntl(<EmployerTemplatesPage />);

        await waitFor(() => {
            expect(screen.getByText('No templates yet · 3 allowed on your plan')).toBeInTheDocument();
        });
    });

    it('states what is saved and what the plan allows as two separate facts', async () => {
        listJobTemplates.mockResolvedValue([template('a'), template('b')]);
        getBilling.mockResolvedValue(billing(3));

        renderIntl(<EmployerTemplatesPage />);

        await waitFor(() => {
            expect(screen.getByText('2 saved · 3 allowed on your plan')).toBeInTheDocument();
        });
    });

    /* Billing can fail on its own; the meter degrades to a plain count. */
    it('falls back to the bare count when the plan limit is unknown', async () => {
        listJobTemplates.mockResolvedValue([template('a'), template('b')]);
        getBilling.mockRejectedValue(new Error('billing down'));

        renderIntl(<EmployerTemplatesPage />);

        await waitFor(() => {
            expect(screen.getByText('2 templates')).toBeInTheDocument();
        });
    });
});
