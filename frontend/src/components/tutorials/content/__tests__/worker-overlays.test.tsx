// @vitest-environment jsdom
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WORKER_TUTORIAL_IDS, type TutorialId } from '@/lib/api/tutorials';
import type { ApplicationHire } from '@/lib/api/worker';
import { useTutorial } from '@/lib/tutorials/use-tutorial';
import { resetHarness, route, serveTutorials, signIn, watchDialogs } from '@/lib/tutorials/__tests__/harness';
import { HiredCelebrationModal } from '@/components/worker/HiredCelebrationModal';
import { ProfileCompleteModal } from '@/components/worker/ProfileCompleteModal';
import en from '@/messages/en.json';
import { dialogCount, preparePlayer, recordsPosted, settle, workerProviders } from './worker-player';

/*
 * A worker tutorial never stacks on the worker's own dialogs: the hire
 * celebration and the profile gate. Both are `Modal`s, which report
 * themselves to the overlay coordinator (R2), so a tutorial asked to open
 * while one is up stays shut -- one dialog on screen at every moment -- and
 * is dropped for that page view rather than opening when the dialog closes
 * (R4). Checked with the real modals, player and content, for every worker
 * tutorial.
 */

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('@/i18n/navigation', async () => ({
    usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (...args: unknown[]) => harness.apiFetch(...args),
    };
});

const TITLES: Record<TutorialId, string> = Object.fromEntries(
    WORKER_TUTORIAL_IDS.map((id) => [id, (en.tutorial as Record<string, { title?: string }>)[id]?.title ?? id]),
) as Record<TutorialId, string>;

const HIRE: ApplicationHire = {
    hired_at: '2026-09-03T18:00:00.000Z',
    seen_at: null,
    acknowledged_at: null,
    start_date: '2026-09-15',
    location: 'Austin, TX',
    shift_schedule: 'Mon-Fri, 7:00-15:30',
    pay: null,
    pay_min: 24,
    pay_max: 28,
    pay_interval: 'hour',
    trade: { category: 'electrician', other: null, canonical_en: null, canonical_es: null },
    company: 'NB Construction',
    details: null,
    employer_reminded_at: null,
} as ApplicationHire;

/** A host page that asks for its tutorial once it knows the worker has not done the task. */
function Host({ id }: { id: TutorialId }) {
    const tutorial = useTutorial(id, { done: false });
    useEffect(() => {
        tutorial.maybeAutoOpen();
    }, [tutorial]);
    return <p>host page</p>;
}

const OVERLAYS: ReadonlyArray<[string, (open: boolean) => ReactNode, string]> = [
    [
        'the hire celebration',
        (open) => (
            <HiredCelebrationModal
                open={open}
                applicationId="app-1"
                jobTitle="Electrician"
                companyName="NB Construction"
                hire={HIRE}
                onClose={() => {}}
            />
        ),
        'celebration',
    ],
    [
        'the profile gate',
        (open) => <ProfileCompleteModal open={open} onClose={() => {}} onSubmit={async () => {}} />,
        'gate',
    ],
];

const CASES = OVERLAYS.flatMap(([name, overlay]) =>
    WORKER_TUTORIAL_IDS.map((id) => [`${id} over ${name}`, id, overlay] as const),
);

let restorePlayer: () => void;
beforeAll(async () => {
    restorePlayer = await preparePlayer();
});
afterAll(() => restorePlayer());

beforeEach(() => {
    resetHarness();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/worker/home';
    signIn('worker');
    serveTutorials([]);
});

describe('worker tutorials and the worker’s own dialogs', () => {
    it.each(CASES)('never opens %s, and does not open once it closes', async (_, id, overlay) => {
        const watch = watchDialogs();
        const view = render(
            <>
                {overlay(true)}
                <Host id={id} />
            </>,
            { wrapper: workerProviders() },
        );
        await settle();

        expect(dialogCount()).toBe(1);
        expect(screen.queryByRole('dialog', { name: TITLES[id] })).toBeNull();

        // The dialog closes on the same page view: the tutorial stays shut.
        view.rerender(
            <>
                {overlay(false)}
                <Host id={id} />
            </>,
        );
        await settle();
        watch.stop();

        expect(dialogCount()).toBe(0);
        expect(watch.most()).toBe(1);
        expect(recordsPosted()).toEqual([]);
    });

    it.each(WORKER_TUTORIAL_IDS)('opens %s when no dialog is up (the control case)', async (id) => {
        render(<Host id={id} />, { wrapper: workerProviders() });

        expect(await screen.findByRole('dialog', { name: TITLES[id] })).toBeInTheDocument();
        expect(dialogCount()).toBe(1);
    });
});
