import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The ways into "Report a problem": the header button (signed-in shells, the
 * global header, onboarding and the shared-job band), the sign-in screens'
 * link, and the error action. Each renders only inside the report provider --
 * outside it, every shell renders exactly what it did before.
 */

const { auth, route } = vi.hoisted(() => ({
    auth: {
        state: {
            isAuthenticated: true,
            userType: 'worker' as 'worker' | 'employer' | null,
            logout: async () => {},
        },
    },
    route: { pathname: '/worker/home' },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.state }));
vi.mock('@/contexts/SidebarProfileContext', () => ({ useSidebarProfile: () => ({ status: 'loading' }) }));
vi.mock('@/contexts/UnreadMessagesContext', () => ({ useUnreadCount: () => 0 }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>
    ),
    usePathname: () => route.pathname,
}));
vi.mock('next/navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/navigation')>()),
    useSearchParams: () => new URLSearchParams(),
}));

import { message, renderIntl, type TestLocale } from '@/components/employer/__tests__/render-intl';
import { ReportProblemContext } from '@/components/report/report-problem-context';
import { ReportEntryButton } from '@/components/report/ReportEntryButton';
import { ReportEntryLink } from '@/components/report/ReportEntryLink';
import { AppShell } from '@/components/layout/AppShell';
import { Header } from '@/components/layout/Header';
import { AuthShell } from '@/components/auth/AuthShell';
import { OnboardingHeader } from '@/components/worker/onboarding/OnboardingHeader';

const FULL = message('report_common.title');

function inside(ui: ReactElement, locale: TestLocale = 'en') {
    const openReport = vi.fn();
    const view = renderIntl(
        <ReportProblemContext value={{ openReport, registerCategoryHint: () => () => {} }}>{ui}</ReportProblemContext>,
        locale,
    );
    return { openReport, ...view };
}

beforeEach(() => {
    auth.state.isAuthenticated = true;
    auth.state.userType = 'worker';
    route.pathname = '/worker/home';
});

describe('ReportEntryButton', () => {
    it('has the full name, a short visible label on phones, and opens the report', async () => {
        const user = userEvent.setup();
        const { openReport } = inside(<ReportEntryButton />);
        const button = screen.getByRole('button', { name: FULL });
        // The short label is part of the full name (WCAG 2.5.3, label in name).
        expect(FULL.startsWith(message('report_common.entry_short'))).toBe(true);
        expect(within(button).getByText(message('report_common.entry_short'))).toBeInTheDocument();
        await user.click(button);
        expect(openReport).toHaveBeenCalledWith({});
    });

    it('passes a category or a role when it is given one', async () => {
        const user = userEvent.setup();
        const { openReport } = inside(<ReportEntryButton category="sign_in" role="worker" />);
        await user.click(screen.getByRole('button', { name: FULL }));
        expect(openReport).toHaveBeenCalledWith({ category: 'sign_in', role: 'worker' });
    });

    it('is kept out of the screenshot only by the sheet, not hidden itself', () => {
        inside(<ReportEntryButton />);
        expect(screen.getByRole('button', { name: FULL }).closest('[data-capture-exclude]')).toBeNull();
    });

    it('renders nothing outside the provider', () => {
        const { container } = renderIntl(<ReportEntryButton />);
        expect(container).toBeEmptyDOMElement();
    });

    it('speaks Spanish', () => {
        inside(<ReportEntryButton />, 'es');
        expect(screen.getByRole('button', { name: 'Reportar un problema' })).toBeInTheDocument();
    });
});

describe('ReportEntryLink', () => {
    it('says "Having trouble? Report a problem" and opens the report for the screen\'s role', async () => {
        const user = userEvent.setup();
        const { openReport } = inside(<ReportEntryLink role="employer" />);
        expect(screen.getByText(message('report_common.entry_link_lead'))).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: FULL }));
        expect(openReport).toHaveBeenCalledWith({ role: 'employer' });
    });

    it('renders nothing outside the provider', () => {
        const { container } = renderIntl(<ReportEntryLink role="worker" />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('the shells carry the entry', () => {
    it('AppShell: in the header actions', async () => {
        const user = userEvent.setup();
        const { openReport } = inside(
            <AppShell role="worker" title="Fake title">
                <p>fake page</p>
            </AppShell>,
        );
        const button = screen.getByRole('button', { name: FULL });
        expect(button.closest('header')).not.toBeNull();
        await user.click(button);
        expect(openReport).toHaveBeenCalledTimes(1);
    });

    it('AppShell: unchanged outside the provider', () => {
        renderIntl(
            <AppShell role="employer" title="Fake title">
                <p>fake page</p>
            </AppShell>,
        );
        expect(screen.queryByRole('button', { name: FULL })).toBeNull();
    });

    it('Header: on the screens it covers, signed in or not', () => {
        route.pathname = '/legal/accept';
        const signedIn = inside(<Header />);
        expect(within(screen.getByRole('banner')).getByRole('button', { name: FULL })).toBeInTheDocument();
        signedIn.unmount();

        auth.state.isAuthenticated = false;
        auth.state.userType = null;
        route.pathname = '/upload/fake-token';
        inside(<Header />);
        expect(within(screen.getByRole('banner')).getByRole('button', { name: FULL })).toBeInTheDocument();
    });

    it('AuthShell: a link below the card, for the variant\'s role', async () => {
        const user = userEvent.setup();
        auth.state.isAuthenticated = false;
        auth.state.userType = null;
        route.pathname = '/auth/worker';
        const worker = inside(
            <AuthShell variant="worker">
                <p data-testid="fake-card">fake form</p>
            </AuthShell>,
        );
        const link = screen.getByRole('button', { name: FULL });
        // Below the card, not inside it.
        expect(screen.getByTestId('fake-card').parentElement?.contains(link)).toBe(false);
        expect(screen.getByTestId('fake-card').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        await user.click(link);
        expect(worker.openReport).toHaveBeenCalledWith({ role: 'worker' });
        // The wordmark is a brand image, so a report screenshot keeps it.
        for (const wordmark of screen.getAllByAltText('Jale')) expect(wordmark).toHaveAttribute('data-capture-safe');
        worker.unmount();

        route.pathname = '/auth/employer';
        const employer = inside(
            <AuthShell variant="employer">
                <p>fake form</p>
            </AuthShell>,
        );
        const links = screen.getAllByRole('button', { name: FULL });
        expect(links).toHaveLength(1);
        await user.click(links[0]);
        expect(employer.openReport).toHaveBeenCalledWith({ role: 'employer' });
    });

    it('OnboardingHeader: beside the language toggle', () => {
        inside(<OnboardingHeader />);
        expect(screen.getByRole('button', { name: FULL })).toBeInTheDocument();
    });

    it('none of the shells show it outside the provider', () => {
        route.pathname = '/legal/accept';
        renderIntl(
            <>
                <Header />
                <AuthShell variant="worker">
                    <p>fake form</p>
                </AuthShell>
                <OnboardingHeader />
            </>,
        );
        expect(screen.queryByRole('button', { name: FULL })).toBeNull();
    });
});
