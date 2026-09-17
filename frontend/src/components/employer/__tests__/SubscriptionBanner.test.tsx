// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

/*
 * Where a dismissal is KEPT is a product decision, not an implementation
 * detail, and the two banners want opposite answers:
 *
 *  - "your payment failed" must come back next session. A permanently
 *    dismissed one is a support ticket.
 *  - "you're on the Free plan" states a standing fact. Re-showing it every
 *    session asks the same employer to dismiss the same sentence forever.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

/** Mutable: two employers sharing one browser is the case under test. */
const authState = { idToken: null as string | null };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState }));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { SubscriptionBanner } from '../SubscriptionBanner';
import { subscriptionSignage } from '@/lib/plan-limit';
import type { EmployerBilling } from '@/lib/api/employer';

const freeBilling: EmployerBilling = {
    planCode: 'employer_free',
    activeJobLimit: 1,
    templateLimit: 1,
    activeJobUsage: 0,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
};

const pastDueBilling: EmployerBilling = {
    ...freeBilling,
    subscription: {
        plan_code: 'employer_pro',
        status: 'past_due',
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        grace_ends_at: null,
    },
};

const FIRST = 'employer-one';
const SECOND = 'employer-two';
/*
 * The stored key is the signage key PLUS the account. Browser storage is per
 * browser, and the unscoped version of these keys meant the first employer to
 * dismiss the free-plan banner hid it from every employer who signed in on
 * that machine afterwards -- including, on a shared office laptop, one who had
 * never been told what their plan does.
 */
const FREE_KEY = `jale.signage.free.employer_free.${FIRST}`;
const LAPSED_KEY = `jale.signage.lapsed.past_due.${FIRST}`;

/** A token whose payload carries `sub` -- the only claim the key derives from. */
function idTokenFor(sub: string): string {
    const body = btoa(JSON.stringify({ sub }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `header.${body}.signature`;
}

function render(billing: EmployerBilling) {
    return renderIntl(<SubscriptionBanner signage={subscriptionSignage(billing)} locale="en" />);
}

const dismissButton = () =>
    screen.getByRole('button', { name: message('common.feedback.dismiss') });

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    authState.idToken = idTokenFor(FIRST);
});

describe('subscription banner dismissal', () => {
    it('remembers a dismissed free-plan banner across sessions', () => {
        const { unmount } = render(freeBilling);
        fireEvent.click(dismissButton());

        expect(screen.queryByText(message('billing.signage.free_title'))).not.toBeInTheDocument();
        expect(localStorage.getItem(FREE_KEY)).toBe('1');
        // Not the session store: that is what made it come back every visit.
        expect(sessionStorage.getItem(FREE_KEY)).toBeNull();

        // A new session -- a new tab, tomorrow. The session store is empty.
        unmount();
        sessionStorage.clear();
        render(freeBilling);
        expect(screen.queryByText(message('billing.signage.free_title'))).not.toBeInTheDocument();
    });

    it('brings a dismissed payment warning back next session', () => {
        const { unmount } = render(pastDueBilling);
        fireEvent.click(dismissButton());

        expect(screen.queryByText(message('billing.signage.lapsed_title'))).not.toBeInTheDocument();
        expect(sessionStorage.getItem(LAPSED_KEY)).toBe('1');
        // Never permanent: a payment that is still failing has to be said again.
        expect(localStorage.getItem(LAPSED_KEY)).toBeNull();

        unmount();
        sessionStorage.clear();
        render(pastDueBilling);
        expect(screen.getByText(message('billing.signage.lapsed_title'))).toBeInTheDocument();
    });

    it('does not dismiss it for the colleague sharing the laptop', () => {
        const { unmount } = render(freeBilling);
        fireEvent.click(dismissButton());
        expect(localStorage.getItem(FREE_KEY)).toBe('1');
        unmount();

        // A different employer signs in on the same browser. They have not
        // dismissed anything, and nobody may dismiss it on their behalf.
        authState.idToken = idTokenFor(SECOND);
        render(freeBilling);

        expect(screen.getByText(message('billing.signage.free_title'))).toBeInTheDocument();
    });

    it('remembers nothing when there is no session to attribute it to', () => {
        // The restore window on a reload. An unscoped dismissal here would be
        // this browser's answer for every account that ever signs in on it.
        authState.idToken = null;
        render(freeBilling);
        fireEvent.click(dismissButton());

        expect(localStorage.length).toBe(0);
        expect(sessionStorage.length).toBe(0);
    });

    it('stays dismissed for the rest of the session it was dismissed in', () => {
        const { unmount } = render(pastDueBilling);
        fireEvent.click(dismissButton());
        unmount();

        render(pastDueBilling);
        expect(screen.queryByText(message('billing.signage.lapsed_title'))).not.toBeInTheDocument();
    });
});
