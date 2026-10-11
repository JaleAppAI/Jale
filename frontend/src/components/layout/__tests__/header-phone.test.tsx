import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The global Header on phones. Below 640px sign-out is an icon and, below
 * 360px, the language pill shows a two-letter code; both keep the names the
 * full controls have, from the catalogues, so a screen reader hears the same
 * thing at every width. Layout itself is measured in a real browser (a design
 * audit); this pins the markup the measurements rely on.
 */

const { auth } = vi.hoisted(() => ({
    auth: {
        state: {
            isAuthenticated: true,
            userType: 'worker' as 'worker' | 'employer' | null,
            logout: vi.fn(async () => {}),
        },
    },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.state }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>
    ),
    usePathname: () => '/legal/accept',
}));

import { message, renderIntl, type TestLocale } from '@/components/employer/__tests__/render-intl';
import { Header } from '../Header';

beforeEach(() => {
    vi.clearAllMocks();
    auth.state.isAuthenticated = true;
    auth.state.userType = 'worker';
});

describe('Header on phones', () => {
    for (const locale of ['en', 'es'] as TestLocale[]) {
        it(`${locale}: the icon sign-out is named by the sign-out copy, and signs out`, async () => {
            const user = userEvent.setup();
            renderIntl(<Header />, locale);
            const name = message('header.sign_out', locale);
            const buttons = screen.getAllByRole('button', { name });
            // One per width range; CSS shows one of them.
            expect(buttons).toHaveLength(2);
            const icon = buttons.find((button) => button.closest('.sm\\:hidden'))!;
            expect(icon).toHaveAttribute('aria-label', name);
            expect(icon).toHaveAttribute('title', name);
            // No text inside: no reserved "Loading..." width.
            expect(icon.textContent).toBe('');
            await user.click(icon);
            expect(auth.state.logout).toHaveBeenCalledTimes(1);
        });

        it(`${locale}: the language pill is named by the language, in that language, and shows the code without reading it`, () => {
            renderIntl(<Header />, locale);
            const other = locale === 'en' ? 'es' : 'en';
            const fullName = message('header.language_toggle', locale);
            const pill = screen.getByRole('link', { name: fullName });
            expect(within(pill).getByText(fullName)).toHaveAttribute('lang', other);
            const code = within(pill).getByText(other.toUpperCase());
            expect(code).toHaveAttribute('aria-hidden', 'true');
        });
    }

    it('signed out: no sign-out at all', () => {
        auth.state.isAuthenticated = false;
        auth.state.userType = null;
        renderIntl(<Header />);
        expect(screen.queryByRole('button', { name: message('header.sign_out') })).toBeNull();
    });
});
