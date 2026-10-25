import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TourId, TutorialOutcome } from '@/lib/api/tutorials';
import { OverlayPresenceProvider, useOverlayRegistry, type OverlayRegistry } from '@/lib/tutorials/overlay';
import { AppTour } from '../AppTour';

/*
 * The app tour overlay on its own, over stand-in pages. jsdom does no layout,
 * so each stand-in control carries its box in `data-box` ("top,left,width,
 * height") and anything inside `data-hidden` reports no boxes at all, the way
 * a `display: none` sidebar does on a phone.
 */

type Box = { top: number; left: number; width: number; height: number };

const CALLOUT_SIZE = { width: 358, height: 160 };

function boxOf(element: Element): Box {
    if (element.getAttribute('role') === 'dialog') return { top: 0, left: 0, ...CALLOUT_SIZE };
    const raw = element.getAttribute('data-box');
    if (!raw) return { top: 0, left: 0, width: 0, height: 0 };
    const [top, left, width, height] = raw.split(',').map(Number);
    return { top, left, width, height };
}

function setViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

let reducedMotion = false;

beforeEach(() => {
    reducedMotion = false;
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
        return (this.closest('[data-hidden]') ? [] : [{}]) as unknown as DOMRectList;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const box = boxOf(this);
        return {
            ...box,
            x: box.left,
            y: box.top,
            right: box.left + box.width,
            bottom: box.top + box.height,
            toJSON: () => box,
        } as DOMRect;
    });
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({
            matches: reducedMotion && query.includes('prefers-reduced-motion'),
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }),
    });
    setViewport(1280, 800);
    document.body.style.overflow = '';
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---- Stand-in pages ---------------------------------------------------------

const SIDEBAR_KEYS = ['dashboard', 'messages', 'applicants', 'templates', 'billing', 'settings'];
const EMPLOYER_TAB_KEYS = ['dashboard', 'messages', 'applicants', 'settings'];
const WORKER_KEYS = ['find_jobs', 'applications', 'profile'];

function Sidebar({ keys, hidden = false }: { keys: string[]; hidden?: boolean }) {
    return (
        <nav aria-label="sidebar" data-hidden={hidden ? '' : undefined}>
            {keys.map((key, index) => (
                <a key={key} href={`#${key}`} data-nav-key={key} data-box={`${80 + 48 * index},16,248,44`}>
                    {key}
                </a>
            ))}
        </nav>
    );
}

function TabBar({ keys, hidden = false }: { keys: string[]; hidden?: boolean }) {
    const width = 390 / keys.length;
    return (
        <nav aria-label="tabs" data-hidden={hidden ? '' : undefined}>
            {keys.map((key, index) => (
                <a key={key} href={`#${key}`} data-nav-key={key} data-box={`784,${index * width},${width},60`}>
                    {key}
                </a>
            ))}
        </nav>
    );
}

function Header({ postJob = true, help = true, phone = false }: { postJob?: boolean; help?: boolean; phone?: boolean }) {
    return (
        <header>
            <button type="button" data-testid="opener">
                Opener
            </button>
            {postJob ? (
                <button type="button" data-tour="post-job" data-box={phone ? '64,16,120,40' : '20,1000,120,40'}>
                    Post Job
                </button>
            ) : null}
            {help ? (
                <button type="button" data-tour="help" data-box={phone ? '64,300,44,44' : '20,1180,44,44'}>
                    Help
                </button>
            ) : null}
        </header>
    );
}

const pages = {
    employerDesktop: () => (
        <>
            <Sidebar keys={SIDEBAR_KEYS} />
            <TabBar keys={EMPLOYER_TAB_KEYS} hidden />
            <Header />
        </>
    ),
    employerPhone: () => (
        <>
            <Sidebar keys={SIDEBAR_KEYS} hidden />
            <TabBar keys={EMPLOYER_TAB_KEYS} />
            <Header phone />
        </>
    ),
    workerPhone: () => (
        <>
            <Sidebar keys={WORKER_KEYS} hidden />
            <TabBar keys={WORKER_KEYS} />
            <Header phone postJob={false} />
        </>
    ),
    helpOnly: () => <Header postJob={false} />,
    nothing: () => <Header postJob={false} help={false} />,
};

// ---- Harness ----------------------------------------------------------------

let registry: OverlayRegistry | null = null;
function RegistryProbe() {
    registry = useOverlayRegistry();
    return null;
}

type Locale = 'en' | 'es';

function Frame({ locale, children }: { locale: Locale; children: ReactNode }) {
    return (
        <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : es} onError={() => {}}>
            <OverlayPresenceProvider>
                <RegistryProbe />
                {children}
            </OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
}

/**
 * The page first, then the tour: in the app the tour's chunk only arrives
 * after the page has committed, and it reads the page as it starts.
 */
function renderTour(page: () => ReactNode, id: TourId = 'employer_app_tour', locale: Locale = 'en') {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    const onUnavailable = vi.fn();
    const Page = page;
    const view = (withTour: boolean) => (
        <Frame locale={locale}>
            <Page />
            {withTour ? <AppTour id={id} onDismiss={onDismiss} onUnavailable={onUnavailable} /> : null}
        </Frame>
    );
    const result = render(view(false));
    act(() => {
        screen.getByTestId('opener').focus();
    });
    result.rerender(view(true));
    return { ...result, onDismiss, onUnavailable, close: () => result.rerender(view(false)) };
}

const dialog = () => screen.getByRole('dialog');
const press = (name: string) =>
    act(() => {
        fireEvent.click(within(dialog()).getByRole('button', { name }));
    });

/** The step titles, from the first step to the last, pressing Next. */
function walk(): string[] {
    const titles: string[] = [];
    for (let turn = 0; turn < 12; turn += 1) {
        const current = dialog();
        titles.push(within(current).getByRole('heading', { level: 2 }).textContent ?? '');
        const next = within(current).queryByRole('button', { name: 'Next' });
        if (!next) break;
        act(() => {
            fireEvent.click(next);
        });
    }
    return titles;
}

const counter = () => within(dialog()).getByText(/^\d+ of \d+$/).textContent;

// ---- Steps ------------------------------------------------------------------

describe('app tour: the steps a screen gets', () => {
    it('employer on a desktop: the sidebar, the post-a-job button and Help, eight steps', () => {
        renderTour(pages.employerDesktop);

        expect(screen.getByRole('dialog', { name: 'Welcome to Jale' })).toBeInTheDocument();
        press('Show me around');
        expect(counter()).toBe('1 of 8');
        expect(walk()).toEqual([
            'Dashboard',
            'Post a job',
            'Messages',
            'Applicants',
            'Templates',
            'Billing',
            'Settings',
            'Help',
        ]);
        expect(counter()).toBe('8 of 8');
        expect(within(dialog()).getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    });

    it('employer on a phone: the four tabs, no Templates or Billing, six steps', () => {
        setViewport(390, 844);
        renderTour(pages.employerPhone);

        press('Show me around');
        expect(counter()).toBe('1 of 6');
        expect(walk()).toEqual(['Dashboard', 'Post a job', 'Messages', 'Applicants', 'Settings', 'Help']);
        expect(counter()).toBe('6 of 6');
    });

    it('worker on a phone: Jobs, My Applications, Profile and Help', () => {
        setViewport(390, 844);
        renderTour(pages.workerPhone, 'worker_app_tour');

        expect(screen.getByRole('dialog', { name: 'You’re all set' })).toBeInTheDocument();
        press('Show me around');
        expect(counter()).toBe('1 of 4');
        expect(walk()).toEqual(['Jobs', 'My Applications', 'Profile', 'Help']);
    });

    it('speaks the person’s language: tú for the worker', () => {
        setViewport(390, 844);
        renderTour(pages.workerPhone, 'worker_app_tour', 'es');

        expect(screen.getByRole('dialog', { name: '¡Todo listo!' })).toBeInTheDocument();
        press('Muéstrame');
        expect(within(dialog()).getByText('1 de 4')).toBeInTheDocument();
        expect(within(dialog()).getByRole('heading', { level: 2 }).textContent).toBe('Trabajos');
    });

    it('passes over a control that has gone by the time its step comes', () => {
        setViewport(390, 844);
        renderTour(pages.employerPhone);
        press('Show me around');
        press('Next');
        expect(counter()).toBe('2 of 6');

        // The Messages tab leaves the page before its step.
        act(() => {
            document.querySelector('[aria-label="tabs"] [data-nav-key="messages"]')?.setAttribute('data-hidden', '');
        });
        press('Next');
        expect(within(dialog()).getByRole('heading', { level: 2 }).textContent).toBe('Applicants');
        expect(counter()).toBe('4 of 6');
    });

    it('with only Help on screen: the welcome card, then the Help step alone', () => {
        const { onDismiss } = renderTour(pages.helpOnly);
        press('Show me around');
        expect(counter()).toBe('1 of 1');
        expect(within(dialog()).queryByRole('button', { name: 'Back' })).toBeNull();
        press('Got it');
        expect(onDismiss).toHaveBeenCalledWith('completed');
    });

    it('with nothing on screen, Help included: unavailable, and nothing is drawn', () => {
        const { onUnavailable, onDismiss } = renderTour(pages.nothing);
        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(registry?.isPresent()).toBe(false);
        expect(document.body.style.overflow).toBe('');
    });
});

// ---- Buttons and outcomes ---------------------------------------------------

describe('app tour: buttons and outcomes', () => {
    it('Got it on the last step completes the tour, once', () => {
        const { onDismiss } = renderTour(pages.employerDesktop);
        press('Show me around');
        walk();
        press('Got it');
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith('completed');
    });

    it('Back returns to the step before, and the first step has no Back', () => {
        renderTour(pages.employerDesktop);
        press('Show me around');
        expect(within(dialog()).queryByRole('button', { name: 'Back' })).toBeNull();
        press('Next');
        expect(within(dialog()).getByRole('heading', { level: 2 }).textContent).toBe('Post a job');
        press('Back');
        expect(within(dialog()).getByRole('heading', { level: 2 }).textContent).toBe('Dashboard');
        expect(counter()).toBe('1 of 8');
    });

    it('Not now on the welcome card skips the tour', () => {
        const { onDismiss } = renderTour(pages.employerDesktop);
        press('Not now');
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('Skip on a step skips the tour', () => {
        const { onDismiss } = renderTour(pages.employerDesktop);
        press('Show me around');
        press('Next');
        press('Skip');
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('Escape skips, from the welcome card and from a step', () => {
        const first = renderTour(pages.employerDesktop);
        act(() => {
            fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        });
        expect(first.onDismiss).toHaveBeenCalledWith('skipped');
        first.unmount();

        const second = renderTour(pages.employerDesktop);
        press('Show me around');
        act(() => {
            fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        });
        expect(second.onDismiss).toHaveBeenCalledTimes(1);
        expect(second.onDismiss).toHaveBeenCalledWith('skipped');
    });
});

// ---- Dialog semantics, focus, motion, presence, placement --------------------

describe('app tour: a dialog the page cannot be used behind', () => {
    it('is a modal dialog named by its own title, on the welcome card and on each step', () => {
        renderTour(pages.employerDesktop);
        const welcome = dialog();
        expect(welcome).toHaveAttribute('aria-modal', 'true');
        const welcomeTitle = document.getElementById(welcome.getAttribute('aria-labelledby') ?? '');
        expect(welcomeTitle?.textContent).toBe('Welcome to Jale');

        press('Show me around');
        const step = dialog();
        expect(step).toHaveAttribute('aria-modal', 'true');
        expect(document.getElementById(step.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Dashboard');
        expect(screen.getByRole('dialog', { name: 'Dashboard' })).toBe(step);
    });

    it('moves focus in, keeps Tab inside, and hands focus back when it ends', () => {
        const { close } = renderTour(pages.employerDesktop);
        const opener = screen.getByTestId('opener');

        expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Show me around' }));

        press('Show me around');
        // The welcome card's button is gone; focus lands on the step's Next.
        expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Next' }));
        press('Next');

        const skip = within(dialog()).getByRole('button', { name: 'Skip' });
        const next = within(dialog()).getByRole('button', { name: 'Next' });
        // Tab from the last control wraps to the first, Shift+Tab the other way.
        act(() => {
            next.focus();
            fireEvent.keyDown(next, { key: 'Tab' });
        });
        expect(document.activeElement).toBe(skip);
        act(() => {
            fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true });
        });
        expect(document.activeElement).toBe(next);
        // Focus that escaped to the page is pulled back in.
        act(() => {
            opener.focus();
            fireEvent.keyDown(opener, { key: 'Tab' });
        });
        expect(dialog().contains(document.activeElement)).toBe(true);

        close();
        expect(document.activeElement).toBe(opener);
    });

    it('locks the page’s scroll while open and restores it after', () => {
        document.body.style.overflow = 'auto';
        const { close } = renderTour(pages.employerDesktop);
        expect(document.body.style.overflow).toBe('hidden');
        close();
        expect(document.body.style.overflow).toBe('auto');
    });

    it('counts as an open overlay while it is up', () => {
        const { close } = renderTour(pages.employerDesktop);
        expect(registry?.isPresent()).toBe(true);
        close();
        expect(registry?.isPresent()).toBe(false);
    });

    it('draws a ringed cutout around the current control, and none on the welcome card', () => {
        renderTour(pages.employerDesktop);
        expect(document.querySelector('[data-tour-ring]')).toBeNull();
        press('Show me around');
        const ring = document.querySelector<HTMLElement>('[data-tour-ring]');
        expect(ring).not.toBeNull();
        // The sidebar's Dashboard link (80,16,248,44), padded by 6.
        expect(ring?.style.top).toBe('74px');
        expect(ring?.style.left).toBe('10px');
        expect(ring?.style.width).toBe('260px');
        expect(ring?.style.height).toBe('56px');
        expect(document.querySelector('svg mask rect[fill="black"]')).not.toBeNull();
    });

    it('moves without transitions when reduced motion is asked for', () => {
        reducedMotion = true;
        renderTour(pages.employerDesktop);
        expect(document.querySelector('[data-app-tour]')).toHaveAttribute('data-motion', 'reduced');
        expect(dialog().className).not.toContain('anim-fade-in');
        press('Show me around');
        expect(dialog().style.transition).toBe('none');
        expect(document.querySelector<HTMLElement>('[data-tour-ring]')?.style.transition).toBe('none');
    });

    it('glides between steps otherwise', () => {
        renderTour(pages.employerDesktop);
        expect(document.querySelector('[data-app-tour]')).toHaveAttribute('data-motion', 'full');
        press('Show me around');
        expect(dialog().style.transition).toContain('top');
    });
});

describe('app tour: placement', () => {
    it('sits right of a sidebar link, below a header button, and above a phone tab', () => {
        renderTour(pages.employerDesktop);
        press('Show me around');
        expect(dialog()).toHaveAttribute('data-side', 'right');
        // The sidebar link's right edge (16 + 248), the cutout padding and the gap.
        expect(dialog().style.left).toBe('284px');
        press('Next');
        expect(dialog()).toHaveAttribute('data-step', 'post_job');
        expect(dialog()).toHaveAttribute('data-side', 'bottom');
    });

    it('sits above a phone tab', () => {
        setViewport(390, 844);
        renderTour(pages.employerPhone);
        press('Show me around');
        expect(dialog()).toHaveAttribute('data-side', 'top');
        expect(dialog().style.left).toBe('16px');
        // 784 - 6 - 14 - 160
        expect(dialog().style.top).toBe('604px');
    });

    it('is placed again when the window is resized', () => {
        renderTour(pages.employerDesktop);
        press('Show me around');
        expect(dialog().style.top).toBe('22px');

        // The layout moves the link further down; a resize follows.
        act(() => {
            document.querySelector('[data-nav-key="dashboard"]')?.setAttribute('data-box', '400,16,248,44');
            window.dispatchEvent(new Event('resize'));
        });
        // Centred on the link: 400 + 22 - 80.
        expect(dialog().style.top).toBe('342px');
        expect(document.querySelector<HTMLElement>('[data-tour-ring]')?.style.top).toBe('394px');
    });

    it('centres itself, with no cutout, while its control is missing', () => {
        renderTour(pages.employerDesktop);
        press('Show me around');
        act(() => {
            document.querySelector('[aria-label="sidebar"]')?.setAttribute('data-hidden', '');
            window.dispatchEvent(new Event('resize'));
        });
        expect(dialog()).toHaveAttribute('data-side', 'center');
        expect(document.querySelector('[data-tour-ring]')).toBeNull();
    });
});
