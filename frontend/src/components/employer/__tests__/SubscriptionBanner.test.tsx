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

const FREE_KEY = 'jale.signage.free.employer_free';
const LAPSED_KEY = 'jale.signage.lapsed.past_due';

function render(billing: EmployerBilling) {
    return renderIntl(<SubscriptionBanner signage={subscriptionSignage(billing)} locale="en" />);
}

const dismissButton = () =>
    screen.getByRole('button', { name: message('common.feedback.dismiss') });

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
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

    it('stays dismissed for the rest of the session it was dismissed in', () => {
        const { unmount } = render(pastDueBilling);
        fireEvent.click(dismissButton());
        unmount();

        render(pastDueBilling);
        expect(screen.queryByText(message('billing.signage.lapsed_title'))).not.toBeInTheDocument();
    });
});
