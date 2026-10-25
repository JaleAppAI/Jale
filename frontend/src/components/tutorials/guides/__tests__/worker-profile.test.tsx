// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import type { WorkerProfileData, WorkerVaultDoc } from '@/lib/api/worker';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { ToastProvider } from '@/components/ui/toast';
import { Spotlight } from '../../spotlight/Spotlight';

/*
 * W4's step-by-step guide over the REAL profile page: the page, its edit form
 * and its document slots, with only the network and the shell stubbed. The
 * guide is drawn the way `GuideHost` draws it (lazy, the shared intro and end
 * buttons), and driven through the real controls.
 *
 * jsdom lays nothing out: every element reports one box, and the engine only
 * needs them to exist.
 */

const { updateWorkerProfile } = vi.hoisted(() => ({ updateWorkerProfile: vi.fn() }));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    updateWorkerProfile,
}));
vi.mock('@/lib/location-search', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/location-search')>()),
    queryLocations: vi.fn(async () => []),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    redirect: vi.fn(),
    usePathname: () => '/worker/profile',
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({ MediaBoardGrid: () => <div data-media-board="grid" /> }));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));
vi.mock('@/components/media-board/NewPostModal', () => ({ NewPostModal: () => null }));
vi.mock('@/components/PayReferenceHint', () => ({ PayReferenceHint: () => null }));

let seed: { profile: WorkerProfileData; docs: WorkerVaultDoc[]; posts: []; next_before: null; next_before_id: null };
vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: seed,
        empty: false,
        errorKind: null,
        refreshing: false,
        refreshError: null,
        retry: vi.fn(),
        refresh: vi.fn(async () => {}),
        setData: vi.fn(),
    }),
}));

import WorkerProfilePage from '@/app/[locale]/worker/profile/page';
import guide from '../worker-profile';

const FULL: WorkerProfileData = {
    id: 'worker-1',
    phone: '+15555550100',
    full_name: 'Test Worker',
    skills: ['Framing'],
    availability: 'part_time',
    years_experience: 4,
    location: 'Austin, TX',
    bio: null,
    certifications: [],
    preferred_cities: [],
    main_trade: 'carpenter',
    main_trade_other: null,
};

const SPARSE: WorkerProfileData = {
    ...FULL,
    full_name: null,
    skills: [],
    availability: null,
    years_experience: null,
    location: null,
    main_trade: null,
};

const SAVED_LICENSE = {
    id: 'v1',
    doc_type: 'driver_license',
    file_name: 'fake-license-file.jpg',
    file_size: 1024,
    uploaded_at: '2026-08-20T00:00:00.000Z',
    url: 'https://files.example.invalid/v1',
} as WorkerVaultDoc;

beforeEach(() => {
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
        return (this.closest('[data-hidden]') ? [] : [{}]) as unknown as DOMRectList;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const box =
            this.getAttribute('role') === 'dialog'
                ? { top: 0, left: 0, width: 326, height: 160 }
                : { top: 300, left: 40, width: 300, height: 44 };
        return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    document.body.style.overflow = '';
    updateWorkerProfile.mockReset();
    updateWorkerProfile.mockResolvedValue({});
});

afterEach(() => {
    vi.restoreAllMocks();
});

const catalogues = { en, es } as const;

function renderGuide(
    profile: WorkerProfileData,
    { docs = [], waitMs = 50, locale = 'en', editFirst = false }: {
        docs?: WorkerVaultDoc[];
        waitMs?: number;
        locale?: 'en' | 'es';
        /** The form is already open when the guide starts. */
        editFirst?: boolean;
    } = {},
) {
    seed = { profile, docs, posts: [], next_before: null, next_before_id: null };
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    const onUnavailable = vi.fn();
    const view = (on: boolean) => (
        <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
            <OverlayPresenceProvider>
                <ToastProvider>
                    <WorkerProfilePage />
                    {on ? (
                        <Spotlight
                            name="worker_profile"
                            resolve="lazy"
                            steps={guide.steps}
                            intro={{
                                ...guide.intro,
                                startKey: 'tutorial.common.guide.worker.start',
                                notNowKey: 'tutorial.common.guide.self',
                            }}
                            done={guide.done}
                            counterKey={guide.counterKey}
                            endKey="tutorial.common.guide.end"
                            waitMs={waitMs}
                            onDismiss={onDismiss}
                            onUnavailable={onUnavailable}
                        />
                    ) : null}
                </ToastProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
    const result = render(view(!editFirst));
    if (editFirst) {
        fireEvent.click(screen.getByRole('button', { name: en.worker_profile.edit_button }));
        result.rerender(view(true));
    }
    return { ...result, onDismiss, onUnavailable };
}

/** Lets the page-watching observers and short waits run. */
async function flush(ms = 0) {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

const callout = () => document.querySelector<HTMLElement>('[data-spotlight] [role="dialog"]');
const stepOf = () => callout()?.getAttribute('data-step') ?? null;
const action = (name: string) => callout()?.querySelector<HTMLButtonElement>(`[data-spotlight-action="${name}"]`) ?? null;
const press = async (name: string) => {
    act(() => {
        fireEvent.click(action(name) as HTMLElement);
    });
    await flush();
};
const control = (name: string) => document.querySelector<HTMLElement>(`[data-guide="${name}"]`);
const fieldOf = (name: string) => {
    const element = control(name);
    if (!element) throw new Error(`no ${name} on screen`);
    return (element.matches('input, select, textarea') ? element : element.querySelector('input, select, textarea')) as
        | HTMLInputElement
        | HTMLSelectElement;
};
async function set(name: string, value: string) {
    act(() => {
        fireEvent.change(fieldOf(name), { target: { value } });
    });
    await flush();
}
async function click(name: string) {
    act(() => {
        fireEvent.click(control(name) as HTMLElement);
    });
    await flush();
}

/** Starts the guide and opens the form. */
async function startAndEdit() {
    await vi.waitFor(() => expect(action('start')).not.toBeNull());
    await press('start');
    expect(stepOf()).toBe('edit');
    await click('profile.edit');
}

/** From the trade step on a full profile, Next through to `id`. */
async function nextUntil(id: string) {
    for (let guard = 0; guard < 12 && stepOf() !== id; guard += 1) {
        expect(action('next')?.disabled).toBe(false);
        await press('next');
    }
    expect(stepOf()).toBe(id);
}

describe('worker_profile guide — steps', () => {
    it('lists the steps in the order the page shows them', () => {
        expect(guide.steps.map((s) => [s.id, s.mode, s.target])).toEqual([
            ['edit', 'action', { guide: 'profile.edit' }],
            ['name', 'next', { guide: 'profile.name' }],
            ['trade', 'auto', { guide: 'profile.trade' }],
            ['trade_other', 'next', { guide: 'profile.trade_other' }],
            ['skills', 'next', { guide: 'profile.skills' }],
            ['availability', 'next', { guide: 'profile.availability' }],
            ['years', 'next', { guide: 'profile.years' }],
            ['location', 'next', { guide: 'profile.location' }],
            ['cities', 'next', { guide: 'profile.cities' }],
            ['documents', 'next', { guide: 'profile.documents' }],
            ['save', 'action', { guide: 'profile.save' }],
            ['saved', 'next', { guide: 'profile.saved' }],
        ]);
        // No static closing card: "Profile saved" is a step that needs the page's own Saved notice.
        expect(guide.done).toBeUndefined();
        // Every step names when it applies, so none waits for a control that has gone.
        expect(guide.steps.every((s) => typeof s.when === 'function')).toBe(true);
    });

    it('gives every step a unique control name on the page', () => {
        renderGuide(FULL, { editFirst: true });
        for (const s of guide.steps) {
            if (!('guide' in s.target) || s.id === 'edit') continue;
            // Shown only while Other is picked / only after a save, when the form has gone.
            if (s.id === 'trade_other' || s.id === 'saved') continue;
            expect(document.querySelectorAll(`[data-guide="${s.target.guide}"]`), s.id).toHaveLength(1);
        }
    });
});

describe('worker_profile guide — Edit and the form', () => {
    it('moves from Edit to the trade as soon as the form is up, without waiting', async () => {
        renderGuide(FULL, { waitMs: 8000 });
        await startAndEdit();
        await flush(20);
        expect(stepOf()).toBe('trade');
    });

    it('starts at the form when it is already open, skipping Edit', async () => {
        renderGuide(FULL, { waitMs: 8000, editFirst: true });
        await vi.waitFor(() => expect(action('start')).not.toBeNull());
        await press('start');
        expect(stepOf()).toBe('trade');
    });

    it('asks for the full name only while it is empty', async () => {
        renderGuide({ ...SPARSE });
        await startAndEdit();
        expect(stepOf()).toBe('name');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.name', 'Ana Ruiz');
        expect(action('next')?.disabled).toBe(false);
        await press('next');
        expect(stepOf()).toBe('trade');
    });

    it('skips the name step when the profile has a name', async () => {
        renderGuide(FULL);
        await startAndEdit();
        expect(stepOf()).toBe('trade');
    });
});

describe('worker_profile guide — trade', () => {
    it('moves on by itself once a trade is picked', async () => {
        renderGuide({ ...FULL, main_trade: null });
        await startAndEdit();
        expect(stepOf()).toBe('trade');
        expect(action('next')).toBeNull();
        await set('profile.trade', 'plumber');
        expect(stepOf()).toBe('skills');
    });

    it('shows Next instead when a trade is already stored', async () => {
        renderGuide(FULL);
        await startAndEdit();
        expect(stepOf()).toBe('trade');
        expect(action('next')?.disabled).toBe(false);
        await press('next');
        // A standard trade: no "Your trade" step.
        expect(stepOf()).toBe('skills');
    });

    it('adds the Your trade step only when Other is picked, held to 2 to 60 characters', async () => {
        renderGuide({ ...FULL, main_trade: null });
        await startAndEdit();
        await set('profile.trade', 'other');
        expect(stepOf()).toBe('trade_other');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.trade_other', ' W ');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.trade_other', 'x'.repeat(61));
        expect(action('next')?.disabled).toBe(true);
        await set('profile.trade_other', 'We');
        expect(action('next')?.disabled).toBe(false);
        await set('profile.trade_other', 'y'.repeat(60));
        expect(action('next')?.disabled).toBe(false);
        await press('next');
        expect(stepOf()).toBe('skills');
    });

    it('drops the Your trade step when the worker switches back to a standard trade', async () => {
        renderGuide(FULL);
        await startAndEdit();
        await set('profile.trade', 'other');
        expect(stepOf()).toBe('trade_other');
        // Back to the trade, and a standard one this time.
        await press('back');
        expect(stepOf()).toBe('trade');
        await set('profile.trade', 'painting');
        expect(stepOf()).toBe('skills');
    });
});

describe('worker_profile guide — the other fields', () => {
    it('holds the skills step until there is one comma-separated skill', async () => {
        renderGuide({ ...FULL, skills: [] });
        await startAndEdit();
        await nextUntil('skills');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.skills', ' , ,');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.skills', 'framing, drywall');
        expect(action('next')?.disabled).toBe(false);
    });

    it('holds an unset availability, which starts empty, until one is picked', async () => {
        renderGuide({ ...FULL, availability: null });
        await startAndEdit();
        await nextUntil('availability');
        expect(fieldOf('profile.availability').value).toBe('');
        expect(action('next')?.disabled).toBe(true);
        expect(callout()).toHaveTextContent(en.tutorial.worker_profile.guide.steps.availability.wait);
        await set('profile.availability', 'flexible');
        expect(action('next')?.disabled).toBe(false);
    });

    it('lets years stay empty, and holds a number the server would refuse', async () => {
        renderGuide({ ...FULL, years_experience: null });
        await startAndEdit();
        await nextUntil('years');
        expect(action('next')?.disabled).toBe(false);
        await set('profile.years', '2.5');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.years', '81');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.years', '0');
        expect(action('next')?.disabled).toBe(false);
    });

    it('holds the years step when a saved number is cleared (it can be changed, not cleared)', async () => {
        renderGuide(FULL);
        await startAndEdit();
        await nextUntil('years');
        expect(action('next')?.disabled).toBe(false);
        await set('profile.years', '');
        expect(action('next')?.disabled).toBe(true);
        expect(callout()).toHaveTextContent('Use a whole number from 0 to 80 to continue.');
        await set('profile.years', '0');
        expect(action('next')?.disabled).toBe(false);
    });

    it('holds the location step until there is a location, and asks for one picked from the list', async () => {
        renderGuide({ ...FULL, location: null });
        await startAndEdit();
        await nextUntil('location');
        expect(callout()).toHaveTextContent('pick your city from the list');
        expect(action('next')?.disabled).toBe(true);
        await set('profile.location', 'Austin');
        expect(action('next')?.disabled).toBe(false);
    });

    it('treats the cities as optional, and says typing alone adds none', async () => {
        renderGuide(FULL);
        await startAndEdit();
        await nextUntil('cities');
        expect(action('next')?.disabled).toBe(false);
        expect(callout()).toHaveTextContent('Typing alone doesn’t add a city. You can add up to 10.');
    });
});

describe('worker_profile guide — documents', () => {
    it('points at the Documents card with Upload and Replace in reach', async () => {
        renderGuide(FULL, { docs: [SAVED_LICENSE] });
        await startAndEdit();
        await nextUntil('documents');
        const card = control('profile.documents') as HTMLElement;
        // An empty slot offers Upload, a filled one Replace; both inside the card.
        expect(within(card).getAllByRole('button', { name: en.worker_profile.documents.upload })).toHaveLength(2);
        expect(within(card).getByRole('button', { name: en.worker_profile.documents.replace })).toBeInTheDocument();
        expect(callout()).toHaveTextContent('Upload to add a Resume, Driver\'s License or Work Authorization Document, or Replace to change one.');
        expect(callout()).toHaveTextContent('Certifications aren’t uploaded here.');
        // Interactive: the pointer reaches the card (no blocker over the cutout).
        expect(document.querySelector('[data-spotlight-blocker="hole"]')).toBeNull();
        expect(action('next')?.disabled).toBe(false);
    });
});

describe('worker_profile guide — Save', () => {
    it('keeps the Save step up while "Please add:" shows', async () => {
        renderGuide(FULL);
        await startAndEdit();
        await nextUntil('save');
        // The name emptied behind the guide's back: Save refuses.
        await set('profile.name', '');
        await click('profile.save');
        expect(screen.getByRole('alert')).toHaveTextContent('Please add: Full name');
        expect(updateWorkerProfile).not.toHaveBeenCalled();
        await flush(100);
        expect(stepOf()).toBe('save');
    });

    it('keeps the Save step up, and the form open, when the save fails', async () => {
        updateWorkerProfile.mockRejectedValue(Object.assign(new Error('server'), { status: 500, code: 'server_error' }));
        renderGuide(FULL);
        await startAndEdit();
        await nextUntil('save');
        await click('profile.save');
        await flush(100);
        expect(updateWorkerProfile).toHaveBeenCalledTimes(1);
        expect(control('profile.form')).not.toBeNull();
        expect(control('profile.form_feedback')).not.toBeNull();
        expect(stepOf()).toBe('save');
    });

    it('finishes when the form closes and Saved shows, without waiting', async () => {
        const { onDismiss } = renderGuide(FULL, { waitMs: 8000 });
        await startAndEdit();
        await nextUntil('save');
        await click('profile.save');
        await flush(20);
        expect(updateWorkerProfile).toHaveBeenCalledTimes(1);
        expect(control('profile.form')).toBeNull();
        expect(control('profile.saved')).not.toBeNull();
        expect(stepOf()).toBe('saved');
        expect(callout()).toHaveTextContent(en.tutorial.worker_profile.guide.done.title);
        await press('next');
        expect(onDismiss).toHaveBeenCalledWith('completed');
    });

    it('never says "Profile saved" when the form closes without a save', async () => {
        const { onDismiss } = renderGuide(FULL, { waitMs: 50 });
        await startAndEdit();
        await nextUntil('save');
        // Cancel (or a tap that leaves the page) closes the form with nothing sent.
        act(() => {
            fireEvent.click(control('profile.cancel') as HTMLElement);
        });
        await flush(200);
        expect(updateWorkerProfile).not.toHaveBeenCalled();
        expect(control('profile.form')).toBeNull();
        expect(control('profile.saved')).toBeNull();
        expect(document.body).not.toHaveTextContent(en.tutorial.worker_profile.guide.done.title);
        expect(callout()).toBeNull();
        expect(onDismiss).toHaveBeenCalled();
    });

    it('walks a brand-new profile from Edit to Saved in order', async () => {
        renderGuide(SPARSE);
        const seen: string[] = [];
        await startAndEdit();
        seen.push(stepOf() as string);
        await set('profile.name', 'Ana Ruiz');
        await press('next');
        seen.push(stepOf() as string);
        await set('profile.trade', 'other');
        seen.push(stepOf() as string);
        await set('profile.trade_other', 'Welder');
        await press('next');
        seen.push(stepOf() as string);
        await set('profile.skills', 'MIG, TIG');
        await press('next');
        seen.push(stepOf() as string);
        await set('profile.availability', 'weekends');
        await press('next');
        seen.push(stepOf() as string);
        await press('next');
        seen.push(stepOf() as string);
        await set('profile.location', 'Austin, TX');
        await press('next');
        seen.push(stepOf() as string);
        await press('next');
        seen.push(stepOf() as string);
        await press('next');
        seen.push(stepOf() as string);
        await click('profile.save');
        await flush(20);
        expect(seen).toEqual([
            'name', 'trade', 'trade_other', 'skills', 'availability', 'years', 'location', 'cities', 'documents', 'save',
        ]);
        expect(updateWorkerProfile.mock.calls[0][1]).toMatchObject({
            full_name: 'Ana Ruiz',
            main_trade: 'other',
            main_trade_other: 'Welder',
            skills: ['MIG', 'TIG'],
            availability: 'weekends',
            location: 'Austin, TX',
        });
        expect(updateWorkerProfile.mock.calls[0][1]).not.toHaveProperty('years_experience');
        expect(callout()).toHaveTextContent(en.tutorial.worker_profile.guide.done.title);
    });

    it('counts its steps in Spanish, in tú', async () => {
        renderGuide(FULL, { locale: 'es' });
        await vi.waitFor(() => expect(action('start')).not.toBeNull());
        expect(callout()).toHaveTextContent('¿Te ayudamos con tu perfil?');
        await press('start');
        expect(callout()).toHaveTextContent('Tu perfil · 1 de');
        expect(callout()).toHaveTextContent('Editar para abrir el formulario con tus datos.');
    });
});

describe('worker_profile slides — say only what the page does', () => {
    const slides = { en: en.tutorial.worker_profile.slides, es: es.tutorial.worker_profile.slides };

    it('does not claim the own-words answers are on this page', () => {
        expect(slides.en.seen.body).toContain('Those answers aren’t shown on this page.');
        expect(slides.es.seen.body).toContain('Esas respuestas no aparecen en esta página.');
        expect(slides.en.seen.title).not.toBe('This is what employers see');
    });

    it('names the three real document slots and promises no certification upload', () => {
        const types = en.worker_profile.documents.types;
        for (const name of [types.resume, types.driver_license, types.work_auth_doc]) expect(slides.en.documents.body).toContain(name);
        expect(slides.en.documents.body).toContain('Certifications aren’t uploaded here.');
        const tipos = es.worker_profile.documents.types;
        for (const name of [tipos.resume, tipos.driver_license, tipos.work_auth_doc]) expect(slides.es.documents.body).toContain(name);
        expect(slides.es.documents.body).toContain('Las certificaciones no se suben aquí.');
    });

    it('lists what Edit changes, trade included', () => {
        expect(slides.en.edit.body).toContain('trade');
        expect(slides.es.edit.body).toContain('oficio');
        // The scene's labels are the page's own.
        expect(en.tutorial.worker_profile.scene.license).toBe(en.worker_profile.documents.types.driver_license);
        expect(es.tutorial.worker_profile.scene.license).toBe(es.worker_profile.documents.types.driver_license);
        expect(es.tutorial.worker_profile.scene.replace).toBe(es.worker_profile.documents.replace);
    });

    it('speaks tú to the worker in the guide', () => {
        const steps = es.tutorial.worker_profile.guide.steps;
        expect(steps.edit.body).toContain('{input, select, touch {Toca} other {Haz clic en}}');
        expect(steps.trade_other.body).toContain('Escribe');
        expect(JSON.stringify(es.tutorial.worker_profile.guide)).not.toMatch(/\b(Toque|Escriba|Elija|usted)\b/);
    });
});
