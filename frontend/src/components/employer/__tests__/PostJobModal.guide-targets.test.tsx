// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * The post-job guide's hooks in the real wizard: every control the guide
 * points at carries `data-guide="post.*"`, the form says which screen is up
 * (`data-step`), and the city says when it was PICKED from the list
 * (`data-picked`), the one sign that tells a pick from typed text. The guide
 * (`components/tutorials/guides/employer-post-job.ts`) reads nothing else.
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

// One suggestion for any text, so a pick can be made.
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

vi.mock('@/lib/api/payReference', () => ({
    getPayReference: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    listJobTemplates: vi.fn().mockResolvedValue([]),
    getBilling: vi.fn().mockRejectedValue(new Error('not needed')),
}));

import { renderIntl } from './render-intl';
import { PostJobModal } from '../PostJobModal';

beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = function scrollIntoView() {};
    }
});

const mark = (name: string) => document.querySelector<HTMLElement>(`[data-guide="${name}"]`);

describe('the post-job wizard’s guide hooks', () => {
    it('marks the dialog, its footer, the form with its screen, and every step-1 control', () => {
        renderIntl(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />);

        expect(mark('post.wizard')).toHaveAttribute('role', 'dialog');
        expect(mark('post.footer')).not.toBeNull();
        expect(mark('post.form')).toHaveAttribute('data-step', '1');
        // Each field mark holds its label and its control.
        expect(mark('post.title')?.querySelector('label')).not.toBeNull();
        expect(mark('post.title')?.querySelector('input')).not.toBeNull();
        expect(mark('post.city')?.querySelector('[role="combobox"]')).not.toBeNull();
        expect(mark('post.trade')?.querySelector('select')).not.toBeNull();
        expect(mark('post.next')?.tagName).toBe('BUTTON');
        expect(mark('post.footer')?.contains(mark('post.next'))).toBe(true);
        // The Other box only while Other is picked.
        expect(mark('post.trade_other')).toBeNull();
        fireEvent.change(mark('post.trade')?.querySelector('select') as HTMLSelectElement, { target: { value: 'other' } });
        expect(mark('post.trade_other')?.querySelector('input')).not.toBeNull();
    });

    it('marks the city picked only once a suggestion is picked, and not for typed text', async () => {
        renderIntl(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />);
        const city = mark('post.city')?.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
        const picked = () => mark('post.city')?.querySelector('[data-picked]') ?? null;

        act(() => city.focus());
        fireEvent.change(city, { target: { value: 'Hayward, CA' } });
        expect(picked()).toBeNull();

        const option = await screen.findByRole('option', { name: 'Hayward, CA' });
        fireEvent.mouseDown(option);
        await waitFor(() => expect(picked()).not.toBeNull());

        // Typing again un-picks it, as it clears the city underneath.
        fireEvent.change(city, { target: { value: 'Hayward, C' } });
        expect(picked()).toBeNull();
    });

    it('says the second screen is up, and marks its workers field, once Next goes through', async () => {
        renderIntl(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />);
        const city = mark('post.city')?.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
        fireEvent.change(mark('post.title')?.querySelector('input') as HTMLInputElement, { target: { value: 'Framer' } });
        fireEvent.change(mark('post.trade')?.querySelector('select') as HTMLSelectElement, { target: { value: 'carpenter' } });
        act(() => city.focus());
        fireEvent.change(city, { target: { value: 'Hayward' } });
        fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hayward, CA' }));
        await waitFor(() => expect(mark('post.city')?.querySelector('[data-picked]')).not.toBeNull());

        expect(mark('post.workers')).toBeNull();
        fireEvent.click(mark('post.next') as HTMLElement);
        await waitFor(() => expect(mark('post.form')).toHaveAttribute('data-step', '2'));
        expect(mark('post.workers')?.querySelector('input')).not.toBeNull();
    });
});
