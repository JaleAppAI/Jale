// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { DoneStep, type DoneNext } from '@/components/worker/onboarding/DoneStep';
import type { OnboardingState, ReferredJobSummary } from '@/lib/api/worker';
import {
    THREE_QUESTIONS,
    catalogues,
    expectNoRawMessageKeys,
    interpolate,
    message,
    onboardingState,
    renderIntl,
    type TestLocale,
} from './render-intl';

const FILLED: Partial<OnboardingState> = {
    profile: {
        fullName: 'Alex Rivera',
        location: { city: 'San Antonio', state: 'Texas', zip: null },
        trade: { key: 'carpenter', other: null },
        yearsExperience: '2-4',
        hasTransportation: true,
        availability: 'full_time',
    },
    trust: {
        questions: THREE_QUESTIONS,
        answers: [
            { index: 1, text: 'I mostly frame houses and set trusses.', source: 'voice' },
            { index: 2, text: 'Nail gun, circular saw, laser level.', source: 'text' },
        ],
    },
};

const REFERRED: ReferredJobSummary = {
    id: '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071',
    title: 'Concrete Finisher',
    company: 'NB Construction',
    location: 'San Antonio, TX',
    payMin: 22,
    payMax: 26,
    payInterval: 'hourly',
    payRaw: null,
    open: true,
};

function props(overrides: Partial<Parameters<typeof DoneStep>[0]> = {}) {
    return {
        state: onboardingState(FILLED),
        next: { kind: 'feed' } as DoneNext,
        onFinish: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof DoneStep>[0];
}

/**
 * The job ticket: the region its "job you came for" eyebrow names. The job's
 * own title is the heading inside it.
 */
function jobTicket(locale: TestLocale = 'en') {
    return screen.getByRole('region', { name: message('worker_onboarding.done.job_heading', locale) });
}

/**
 * The docked stub, found whether it is showing or stowed. `hidden: true`
 * because a stowed stub is `aria-hidden`: a query without it would find
 * nothing, and an assertion that it is hidden would pass for a stub that was
 * never drawn at all. No `name` either: an `aria-hidden` element has no
 * accessible name to match, so its label is asserted as the attribute.
 */
function jobDock() {
    return screen.getByRole('complementary', { hidden: true });
}

/**
 * jsdom has no IntersectionObserver, so the stub's tests bring this one. It
 * records what it was asked to watch and with what margin, and `report`
 * delivers an entry the way a browser does after a scroll.
 */
class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = [];
    readonly options: IntersectionObserverInit | undefined;
    readonly targets: Element[] = [];
    readonly disconnect = vi.fn();
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.callback = callback;
        this.options = options;
        FakeIntersectionObserver.instances.push(this);
    }

    observe(target: Element) {
        this.targets.push(target);
    }

    unobserve() {}

    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }

    report(isIntersecting: boolean) {
        const entries = this.targets.map((target) => ({ isIntersecting, target }) as IntersectionObserverEntry);
        act(() => this.callback(entries, this as unknown as IntersectionObserver));
    }
}

function latestObserver() {
    const observer = FakeIntersectionObserver.instances.at(-1);
    if (!observer) throw new Error('DoneStep created no IntersectionObserver');
    return observer;
}

describe('DoneStep', () => {
    it('summarises the profile an employer will see', () => {
        renderIntl(<DoneStep {...props()} />);
        expect(screen.getByText(message('worker_onboarding.done.title'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.summary.name'))).toBeInTheDocument();
        expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
        expect(screen.getByText('San Antonio, Texas')).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.trade.carpenter'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.experience.2-4'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.availability.full_time'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.transport.yes'))).toBeInTheDocument();
    });

    it('summarises it in Spanish', () => {
        renderIntl(<DoneStep {...props()} />, 'es');
        expect(screen.getByText(message('worker_onboarding.done.title', 'es'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.trade.carpenter', 'es'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.summary.availability', 'es'))).toBeInTheDocument();
    });

    it('reads back every answer in the worker\'s own words, badged by how it arrived', () => {
        renderIntl(<DoneStep {...props()} />);
        expect(screen.getByText(message('worker_onboarding.done.own_words'))).toBeInTheDocument();
        expect(screen.getByText(THREE_QUESTIONS[0].q_en)).toBeInTheDocument();
        expect(screen.getByText(/I mostly frame houses/)).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.common.voice_badge'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.common.typed_badge'))).toBeInTheDocument();
        // The unanswered third question has no row.
        expect(screen.queryByText(THREE_QUESTIONS[2].q_en)).not.toBeInTheDocument();
    });

    it('shows the questions in Spanish when that is the locale', () => {
        renderIntl(<DoneStep {...props()} />, 'es');
        expect(screen.getByText(THREE_QUESTIONS[0].q_es)).toBeInTheDocument();
    });

    it('says it is still reading while the extraction runs', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: { status: 'extracting', extracted: null, summary_en: null, summary_es: null },
            }),
        })} />);
        expect(screen.getByText(message('worker_onboarding.done.working'))).toBeInTheDocument();
        expect(screen.queryByText(message('worker_onboarding.done.extracted'))).not.toBeInTheDocument();
    });

    it('flips to the extracted skills, chips and summary when it completes', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: {
                    status: 'completed',
                    extracted: {
                        skills: [{ label_en: 'Framing', label_es: 'Estructura', source: [1] }],
                        safety: [{ label_en: 'Fall protection', label_es: 'Protección contra caídas', source: [1] }],
                    },
                    summary_en: 'Frames residential builds and sets trusses.',
                    summary_es: 'Hace estructura de casas y coloca vigas.',
                },
            }),
        })} />);
        expect(screen.getByText(message('worker_onboarding.done.extracted'))).toBeInTheDocument();
        expect(screen.getByText('Framing')).toBeInTheDocument();
        expect(screen.getByText('Fall protection')).toBeInTheDocument();
        expect(screen.getByText('Frames residential builds and sets trusses.')).toBeInTheDocument();
        expect(screen.queryByText(message('worker_onboarding.done.working'))).not.toBeInTheDocument();
    });

    it('shows the Spanish chips and summary on the Spanish locale', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: {
                    status: 'completed',
                    extracted: { skills: [{ label_en: 'Framing', label_es: 'Estructura', source: [1] }] },
                    summary_en: 'Frames residential builds.',
                    summary_es: 'Hace estructura de casas.',
                },
            }),
        })} />, 'es');
        expect(screen.getByText('Estructura')).toBeInTheDocument();
        expect(screen.getByText('Hace estructura de casas.')).toBeInTheDocument();
    });

    it('stays honest when the extraction failed — the answers still stand', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: { status: 'failed', extracted: null, summary_en: null, summary_es: null },
            }),
        })} />);
        expect(screen.getByText(message('worker_onboarding.done.failed'))).toBeInTheDocument();
    });

    it('offers no way back into the questions — the run is already complete', () => {
        renderIntl(<DoneStep {...props()} />);
        expect(screen.queryByRole('button', { name: message('worker_onboarding.common.back') })).not.toBeInTheDocument();
    });
});

/**
 * Where the summary goes next, in its four shapes. Which one applies is
 * `OnboardingFlow`'s decision (it holds the server's job, the tab's stash and
 * the routes); this screen draws the one it is handed.
 */
describe('DoneStep — the way on', () => {
    it('shows the open job as a ticket with Apply, and every job beneath it', async () => {
        const onFinish = vi.fn();
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED }, onFinish })} />);

        const card = jobTicket();
        expect(within(card).getByText('Concrete Finisher')).toBeInTheDocument();
        expect(within(card).getByText('NB Construction · San Antonio, TX')).toBeInTheDocument();
        // The app's own pay formatter, not the raw columns.
        expect(within(card).getByText('$22–$26/hr')).toBeInTheDocument();

        // Exactly two ways on: this job, or all of them.
        expect(screen.getAllByRole('button')).toHaveLength(2);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.done.apply') }));
        expect(onFinish).toHaveBeenLastCalledWith('apply');
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.done.see_all_jobs') }));
        expect(onFinish).toHaveBeenLastCalledWith('jobs');
    });

    it('falls back to the legacy pay text when the job has no structured pay', () => {
        renderIntl(<DoneStep {...props({
            next: { kind: 'apply', job: { ...REFERRED, payMin: null, payMax: null, payInterval: null, payRaw: '$20 an hour' } },
        })} />);
        expect(within(jobTicket()).getByText('$20 an hour')).toBeInTheDocument();
    });

    it('leaves the pay line out when the job states none', () => {
        renderIntl(<DoneStep {...props({
            next: { kind: 'apply', job: { ...REFERRED, payMin: null, payMax: null, payInterval: null, payRaw: null } },
        })} />);
        expect(within(jobTicket()).queryByText(/\$/)).not.toBeInTheDocument();
    });

    it('says plainly when the job has closed, and offers the feed', async () => {
        const onFinish = vi.fn();
        renderIntl(<DoneStep {...props({ next: { kind: 'closed', job: { ...REFERRED, open: false } }, onFinish })} />);

        expect(screen.getByText(interpolate(message('worker_onboarding.done.job_closed'), { title: REFERRED.title })))
            .toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('worker_onboarding.done.apply') })).not.toBeInTheDocument();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.done.see_jobs') }));
        expect(onFinish).toHaveBeenCalledWith('jobs');
    });

    it('offers the feed when nothing was referred — never the profile', async () => {
        const onFinish = vi.fn();
        renderIntl(<DoneStep {...props({ onFinish })} />);

        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: message('worker_onboarding.common.go_to_profile') })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.done.see_jobs') }));
        expect(onFinish).toHaveBeenCalledWith('jobs');
    });

    it('keeps the old hand-off when only this tab knows the job', async () => {
        const onFinish = vi.fn();
        renderIntl(<DoneStep {...props({ next: { kind: 'handoff' }, onFinish })} />);

        expect(screen.getAllByRole('button')).toHaveLength(1);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.done.cta_job') }));
        expect(onFinish).toHaveBeenCalledWith('handoff');
    });

    it('draws the ticket in Spanish', () => {
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />, 'es');

        expect(screen.getByRole('region', { name: message('worker_onboarding.done.job_heading', 'es') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_onboarding.done.apply', 'es') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_onboarding.done.see_all_jobs', 'es') })).toBeInTheDocument();
        expect(within(jobTicket('es')).getByText('$22–$26/hora')).toBeInTheDocument();
    });

    it('renders no raw message key in any shape, in either language', () => {
        const shapes: DoneNext[] = [
            { kind: 'apply', job: REFERRED },
            { kind: 'closed', job: { ...REFERRED, open: false } },
            { kind: 'handoff' },
            { kind: 'feed' },
        ];
        for (const locale of ['en', 'es'] as const) {
            for (const next of shapes) {
                const view = renderIntl(<DoneStep {...props({ next })} />, locale);
                expectNoRawMessageKeys();
                view.unmount();
            }
        }
    });
});

/**
 * Decided 2026-10-02: the job they came for stays at the bottom of
 * the summary, as a ticket that carries its own Apply below a tear line.
 */
describe('DoneStep — the job ticket', () => {
    it('names the ticket with its eyebrow and heads it with the job, Apply torn off below', async () => {
        const onFinish = vi.fn();
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED }, onFinish })} />);

        const ticket = jobTicket();
        expect(within(ticket).getByText(message('worker_onboarding.done.job_heading'))).toBeInTheDocument();
        expect(within(ticket).getByRole('heading', { level: 2, name: 'Concrete Finisher' })).toBeInTheDocument();
        expect(within(ticket).getByText('NB Construction · San Antonio, TX')).toBeInTheDocument();
        expect(within(ticket).getByText('$22–$26/hr')).toBeInTheDocument();

        // Apply is on the ticket itself...
        await userEvent.click(within(ticket).getByRole('button', { name: message('worker_onboarding.done.apply') }));
        expect(onFinish).toHaveBeenLastCalledWith('apply');

        // ...and the way past it is the quiet button under it, not on it.
        const seeAll = { name: message('worker_onboarding.done.see_all_jobs') };
        expect(within(ticket).queryByRole('button', seeAll)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', seeAll));
        expect(onFinish).toHaveBeenLastCalledWith('jobs');
    });

    it('has no pay line at all when the job states no pay', () => {
        renderIntl(<DoneStep {...props({
            next: { kind: 'apply', job: { ...REFERRED, payMin: null, payMax: null, payInterval: null, payRaw: null } },
        })} />);

        const ticket = jobTicket();
        expect(within(ticket).getByRole('heading', { level: 2, name: 'Concrete Finisher' })).toBeInTheDocument();
        expect(ticket).not.toHaveTextContent('$');
    });
});

/**
 * The docked stub: Apply kept one tap away while the ticket is out of sight,
 * gone the moment the ticket's top edge clears the stub. Its visibility is
 * whatever the observer last said about the ticket.
 */
describe('DoneStep — the docked stub', () => {
    beforeEach(() => {
        FakeIntersectionObserver.instances = [];
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('stays stowed until the observer first reports, so a tall screen never flashes it', () => {
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />);

        // It watches the ticket, and only the ticket.
        expect(latestObserver().targets).toEqual([jobTicket()]);
        expect(jobDock()).toHaveAttribute('aria-label', message('worker_onboarding.done.job_heading'));
        expect(jobDock()).toHaveAttribute('inert');
        expect(jobDock()).toHaveAttribute('aria-hidden', 'true');
        expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: message('worker_onboarding.done.apply') })).toHaveLength(1);
    });

    it('docks while the ticket is out of sight, and its Apply is the same Apply', async () => {
        const onFinish = vi.fn();
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED }, onFinish })} />);

        latestObserver().report(false);

        const dock = screen.getByRole('complementary', { name: message('worker_onboarding.done.job_heading') });
        expect(dock).not.toHaveAttribute('inert');
        expect(dock).not.toHaveAttribute('aria-hidden');
        expect(within(dock).getByText('Concrete Finisher')).toBeInTheDocument();
        expect(dock).toHaveTextContent('$22–$26/hr · NB Construction');

        await userEvent.click(within(dock).getByRole('button', { name: message('worker_onboarding.done.apply') }));
        expect(onFinish).toHaveBeenCalledTimes(1);
        expect(onFinish).toHaveBeenCalledWith('apply');
    });

    it('stows itself again once the ticket comes into view', () => {
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />);

        latestObserver().report(false);
        expect(screen.getByRole('complementary')).toBeInTheDocument();

        latestObserver().report(true);
        expect(jobDock()).toHaveAttribute('inert');
        expect(jobDock()).toHaveAttribute('aria-hidden', 'true');
        expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: message('worker_onboarding.done.apply') })).toHaveLength(1);
    });

    it("draws the stub line at the stub's own height", () => {
        // jsdom lays nothing out, so every offsetHeight is 0; give the stub a
        // real one. The observer's viewport must end where the stub begins.
        const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
            .mockImplementation(function (this: HTMLElement) {
                return this.tagName === 'ASIDE' ? 72 : 0;
            });
        try {
            renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />);
            expect(latestObserver().options?.rootMargin).toBe('0px 0px -72px 0px');
        } finally {
            height.mockRestore();
        }
    });

    it('drops the pay, and its separator, when the job states none', () => {
        renderIntl(<DoneStep {...props({
            next: { kind: 'apply', job: { ...REFERRED, payMin: null, payMax: null, payInterval: null, payRaw: null } },
        })} />);

        latestObserver().report(false);
        const dock = screen.getByRole('complementary');
        expect(dock).not.toHaveTextContent('$');
        expect(dock).not.toHaveTextContent('·');
        expect(dock).toHaveTextContent('NB Construction');
    });

    it('says it in Spanish, pay included', () => {
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />, 'es');

        latestObserver().report(false);
        const dock = screen.getByRole('complementary', { name: message('worker_onboarding.done.job_heading', 'es') });
        expect(dock).toHaveTextContent('$22–$26/hora · NB Construction');
        expect(within(dock).getByRole('button', { name: message('worker_onboarding.done.apply', 'es') })).toBeInTheDocument();
    });

    it('lives in document.body, outside the summary, and leaves with it', () => {
        // A `fixed` stub inside the summary would be placed against any
        // transformed ancestor -- DoneStep's own fade-in is one -- instead of
        // the viewport. jsdom does no layout, so the guard is WHERE it is.
        const view = renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />);
        const dock = jobDock();
        expect(dock.parentElement).toBe(document.body);
        expect(view.container.contains(dock)).toBe(false);

        view.unmount();
        expect(document.body.contains(dock)).toBe(false);
    });

    it('stays out of the server render, and joins on hydration without a mismatch', async () => {
        // The portal needs `document.body`, so the server must draw no stub
        // at all -- and the hydration pass must agree with it, or React
        // reports a mismatch and re-renders the summary from scratch.
        const ui = (
            <NextIntlClientProvider locale="en" messages={catalogues.en} onError={() => {}}>
                <DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />
            </NextIntlClientProvider>
        );
        const html = renderToString(ui);
        expect(html).not.toContain('<aside');

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);
        const onRecoverableError = vi.fn();
        const root = await act(async () => hydrateRoot(container, ui, { onRecoverableError }));
        try {
            expect(onRecoverableError).not.toHaveBeenCalled();
            expect(jobDock().parentElement).toBe(document.body);
        } finally {
            act(() => root.unmount());
            container.remove();
        }
    });

    it('disconnects the observer when the summary goes away', () => {
        const view = renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED } })} />);
        const observer = latestObserver();
        expect(observer.disconnect).not.toHaveBeenCalled();

        view.unmount();
        expect(observer.disconnect).toHaveBeenCalled();
    });
});

describe('DoneStep — a browser without IntersectionObserver', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('never shows the stub: the ticket alone is the whole way on', async () => {
        vi.stubGlobal('IntersectionObserver', undefined);
        const onFinish = vi.fn();
        renderIntl(<DoneStep {...props({ next: { kind: 'apply', job: REFERRED }, onFinish })} />);

        expect(jobDock()).toHaveAttribute('inert');
        expect(jobDock()).toHaveAttribute('aria-hidden', 'true');
        await userEvent.click(within(jobTicket()).getByRole('button', { name: message('worker_onboarding.done.apply') }));
        expect(onFinish).toHaveBeenCalledWith('apply');
    });
});

describe('DoneStep — the other ways on carry no ticket', () => {
    beforeEach(() => {
        FakeIntersectionObserver.instances = [];
        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each<[string, DoneNext]>([
        ['closed', { kind: 'closed', job: { ...REFERRED, open: false } }],
        ['handoff', { kind: 'handoff' }],
        ['feed', { kind: 'feed' }],
    ])('%s: no ticket, no stub, nothing observed', (_, next) => {
        renderIntl(<DoneStep {...props({ next })} />);

        expect(screen.queryByRole('region', { name: message('worker_onboarding.done.job_heading'), hidden: true }))
            .not.toBeInTheDocument();
        expect(screen.queryByRole('complementary', { hidden: true })).not.toBeInTheDocument();
        expect(FakeIntersectionObserver.instances).toHaveLength(0);
    });
});
