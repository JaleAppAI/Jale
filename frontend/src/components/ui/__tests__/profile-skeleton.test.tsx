// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { ProfileSkeleton } from '../profile-skeleton';
import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * The three profile pages each mount this twice -- in the page's own
 * `showSkeleton` branch and in the route's `loading.tsx` -- and BOTH sites are
 * unreachable from a page test that seeds `usePageData` with ready data. So it
 * is exercised directly here instead: `tsc` proves the props typecheck, but
 * only a render proves `SkeletonRegion`'s `useTranslations('common')` resolves
 * and that neither head shape throws.
 */

describe('ProfileSkeleton', () => {
    it('announces itself once as a labelled live region', () => {
        renderIntl(<ProfileSkeleton />);
        // One region per skeleton, not one per panel: a nested second
        // `role="status"` would say "Loading..." twice for a single card.
        const region = screen.getByRole('status');
        expect(region).toHaveTextContent('Loading...');
    });

    it('draws the edit-button head by default -- an avatar, a title and an action pill', () => {
        const { container } = renderIntl(<ProfileSkeleton tiles={5} chips={3} />);
        // `h-9`, matching `Button size="sm"`, so the header does not resize on
        // the swap to the real Edit button.
        expect(container.querySelector('.h-9.w-20.rounded-full')).not.toBeNull();
        expect(container.querySelectorAll('[data-skeleton="tiles"] > div')).toHaveLength(5);
        expect(container.querySelectorAll('[data-skeleton="requirements"] > div')).toHaveLength(3);
    });

    it('draws the status-badge head with no action pill and no back link by default', () => {
        const { container } = renderIntl(<ProfileSkeleton head="status-badge" />);
        expect(container.querySelector('.h-9.w-20.rounded-full')).toBeNull();
    });

    it('renders the applicant card shape -- six tiles, no chips, no paragraph', () => {
        const { container } = renderIntl(
            <ProfileSkeleton tiles={6} chips={0} text={0} head="status-badge" withBackLink />,
        );
        expect(container.querySelectorAll('[data-skeleton="tiles"] > div')).toHaveLength(6);
        expect(container.querySelectorAll('[data-skeleton="requirements"] > div')).toHaveLength(0);
        expect(container.querySelectorAll('[data-skeleton="text"] > div')).toHaveLength(0);
        // KNOWN DEVIATION (see the component): `FactsCardSkeleton` traces the
        // JOB card, so the pay headline block is drawn even here. Asserted so
        // the day it becomes suppressible, this test says so out loud.
        expect(container.querySelector('[data-skeleton="headline"]')).not.toBeNull();
    });

    it('reserves the back link only when asked', () => {
        const withLink = renderIntl(<ProfileSkeleton withBackLink />);
        expect(withLink.container.querySelector('.mb-4.h-3\\.5.w-24')).not.toBeNull();
        withLink.unmount();

        const withoutLink = renderIntl(<ProfileSkeleton />);
        expect(withoutLink.container.querySelector('.mb-4.h-3\\.5.w-24')).toBeNull();
    });
});
