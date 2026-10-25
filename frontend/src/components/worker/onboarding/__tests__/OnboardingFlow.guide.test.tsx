// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { OnboardingState } from '@/lib/api/worker';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';

/*
 * W1's step-by-step guide over the REAL onboarding flow: the flow's screens,
 * driven by a small stand-in for the onboarding engine (the server cursor), and
 * the real spotlight engine playing the guide's steps. Every branch the guide
 * names gets its own test: Other and its box, typed and voice answers, the
 * minimum lengths, the lock note and the last question, a city typed but not
 * picked, "Did you mean…?", a run parked on a typed trade, a failed save, and
 * a run resumed mid-way.
 */

const { api, router } = vi.hoisted(() => ({
    api: {
        getWorkerOnboarding: vi.fn(),
        postOnboardingAnswers: vi.fn(),
        postOnboardingBack: vi.fn(),
        patchOnboardingLanguage: vi.fn(),
    },
    router: { replace: vi.fn(), push: vi.fn() },
}));

vi.mock('@/lib/api/worker', () => api);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => router, usePathname: () => '/worker/onboarding' }));
vi.mock('@/lib/location-search', () => ({
    queryLocations: vi.fn(async (q: string) => (
        q.toLowerCase().startsWith('el p')
            ? [{
                label: 'El Paso, TX 79901', cityKey: 'el-paso-tx', zip: '79901',
                city: 'El Paso', state: 'TX', latitude: 31.7, longitude: -106.4,
                source: 'geocoded_zip' as const,
            }]
            : []
    )),
    locationDatasetFailed: () => false,
}));

import { OnboardingFlow } from '@/components/worker/onboarding/OnboardingFlow';
import { Spotlight } from '@/components/tutorials/spotlight/Spotlight';
import guide from '@/components/tutorials/guides/worker-onboarding';
import { THREE_QUESTIONS, onboardingState } from './render-intl';

// ── A stand-in for the onboarding engine ────────────────────────────────────

const ORDER = [
    'legal.review', 'profile.name', 'profile.location', 'profile.trade', 'profile.custom_trade',
    'profile.experience', 'profile.transportation', 'profile.availability',
    'trust.question.1', 'trust.question.2', 'trust.question.3',
];

type Engine = {
    state: OnboardingState;
    /** The next location answer gets "Did you mean…?" instead of moving on. */
    confirmNext: boolean;
    /** The next save fails as if offline. */
    failNext: boolean;
};

let engine: Engine;

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function at(stepKey: string, overrides: Partial<OnboardingState> = {}): OnboardingState {
    const base = onboardingState({ trust: { questions: THREE_QUESTIONS, answers: [] }, ...overrides });
    return { ...base, run: { ...base.run, stepKey } };
}

function after(stepKey: string, state: OnboardingState): string | null {
    let next = ORDER.indexOf(stepKey) + 1;
    if (ORDER[next] === 'profile.custom_trade' && state.profile.trade?.key !== 'other') next += 1;
    return ORDER[next] ?? null;
}

function post(_token: string, body: { answers: Array<{ stepKey: string; value: unknown }> }) {
    if (engine.failNext) {
        engine.failNext = false;
        return Promise.reject(new TypeError('Failed to fetch'));
    }
    const state = engine.state;
    for (const item of body.answers) {
        const value = item.value as Record<string, unknown> | string | boolean;
        switch (item.stepKey) {
            case 'profile.name':
                state.profile.fullName = value as string;
                break;
            case 'profile.location':
                if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'confirm') {
                    state.pendingLocationConfirm = null;
                    if (!value.accept) {
                        state.profile.location = null;
                        continue;
                    }
                } else if (engine.confirmNext) {
                    engine.confirmNext = false;
                    state.pendingLocationConfirm = { city: 'El Paso', state: 'TX' };
                    continue;
                } else {
                    state.profile.location = value as never;
                }
                break;
            case 'profile.trade':
                state.profile.trade = { key: value as string, other: null } as never;
                break;
            case 'profile.custom_trade':
                state.profile.trade = { key: 'other', other: value as string } as never;
                break;
            case 'profile.experience':
                state.profile.yearsExperience = value as never;
                break;
            case 'profile.transportation':
                state.profile.hasTransportation = value as boolean;
                break;
            case 'profile.availability':
                state.profile.availability = value as never;
                break;
            default: {
                const index = Number(item.stepKey.slice(-1));
                const text = (value as { text: string }).text;
                state.trust.answers = [...state.trust.answers.filter((a) => a.index !== index), { index, text, source: 'text' } as never];
            }
        }
        const next = after(item.stepKey, state);
        if (next === null) state.lifecycle = 'ready';
        else state.run.stepKey = next;
    }
    state.run.lockVersion += 1;
    return Promise.resolve({ kind: 'saved', state: clone(state) });
}

// ── Rendering ───────────────────────────────────────────────────────────────

const catalogues = { en, es } as const;

function renderGuided(state: OnboardingState, locale: 'en' | 'es' = 'en') {
    engine = { state: clone(state), confirmNext: false, failNext: false };
    api.postOnboardingAnswers.mockImplementation(post);
    api.postOnboardingBack.mockImplementation(async () => {
        engine.state.run.stepKey = 'profile.trade';
        engine.state.profile.trade = null;
        engine.state.run.lockVersion += 1;
        return clone(engine.state);
    });
    api.getWorkerOnboarding.mockImplementation(async () => clone(engine.state));
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    const onUnavailable = vi.fn();
    render(
        <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
            <OverlayPresenceProvider>
                <OnboardingFlow token="id-token" initialState={clone(state)} />
                <Spotlight
                    name="worker_onboarding"
                    resolve="lazy"
                    waitMs={60}
                    steps={guide.steps}
                    intro={{
                        ...guide.intro,
                        startKey: 'tutorial.common.guide.worker.start',
                        notNowKey: 'tutorial.common.guide.self',
                    }}
                    counterKey={guide.counterKey}
                    endKey="tutorial.common.guide.end"
                    onDismiss={onDismiss}
                    onUnavailable={onUnavailable}
                />
            </OverlayPresenceProvider>
        </NextIntlClientProvider>,
    );
    return { onDismiss, onUnavailable };
}

function callout(): HTMLElement | null {
    const layer = document.querySelector('[data-spotlight]');
    const dialogs = layer ? Array.from(layer.querySelectorAll<HTMLElement>('[role="dialog"]')) : [];
    return dialogs.at(-1) ?? null;
}

const stepNow = () => callout()?.getAttribute('data-step') ?? null;

async function expectStep(id: string) {
    await vi.waitFor(() => expect(stepNow()).toBe(id), { timeout: 2000 });
}

async function flush(ms = 0) {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

function guideNext() {
    const button = within(callout()!).getByRole('button', { name: 'Next' });
    expect(button).toBeEnabled();
    act(() => button.click());
}

function guideNextDisabled(): boolean {
    return within(callout()!).getByRole('button', { name: 'Next' }).hasAttribute('disabled');
}

function guided(name: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-guide="${name}"]`);
    if (!element) throw new Error(`no [data-guide="${name}"] on screen`);
    return element;
}

function type(box: HTMLElement, text: string) {
    fireEvent.change(box, { target: { value: text } });
}

async function start() {
    const intro = await screen.findByRole('dialog', { name: en.tutorial.worker_onboarding.guide.intro_title });
    act(() => within(intro).getByRole('button', { name: en.tutorial.common.guide.worker.start }).click());
}

async function pickElPaso() {
    const box = within(guided('onb.about.location')).getByRole('combobox');
    act(() => box.focus());
    type(box, 'El Pa');
    const option = await screen.findByRole('option', { name: 'El Paso, TX 79901' });
    fireEvent.mouseDown(option);
}

async function throughAbout() {
    await expectStep('name');
    const [first, last] = within(guided('onb.about.name')).getAllByRole('textbox');
    type(first, 'Ana');
    type(last, 'Lopez');
    guideNext();
    await expectStep('location');
    await pickElPaso();
    await expectStep('about_continue');
    act(() => guided('onb.about.continue').click());
}

function press(groupName: string, label: string) {
    act(() => within(guided(groupName)).getByRole('button', { name: label }).click());
}

async function throughWork() {
    await expectStep('years');
    press('onb.work.years', '2–4 years');
    await expectStep('transport');
    press('onb.work.transport', 'No');
    await expectStep('availability');
    press('onb.work.availability', 'Weekends');
    await expectStep('work_continue');
    act(() => guided('onb.work.continue').click());
}

async function answer(question: 1 | 2 | 3, text = 'I poured and finished a long driveway.') {
    await expectStep(`q${question}_answer`);
    type(within(guided(`onb.q${question}.answer`)).getByRole('textbox'), text);
    guideNext();
}

beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const box = this.getAttribute('role') === 'dialog'
            ? { top: 0, left: 0, width: 358, height: 160 }
            : { top: 300, left: 16, width: 358, height: 48 };
        return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('W1 guide: the whole flow, in the server order', () => {
    it('walks terms, about you, trade, work, the three questions and the summary, then completes', async () => {
        const { onDismiss } = renderGuided(at('legal.review'));
        await start();

        await expectStep('terms');
        act(() => guided('onb.terms.accept').click());
        await throughAbout();

        await expectStep('trade');
        press('onb.trade.list', 'Concrete');
        await expectStep('trade_continue');
        act(() => guided('onb.trade.continue').click());

        await throughWork();

        await expectStep('q1_lock');
        guideNext();
        await answer(1);
        await expectStep('q1_next');
        act(() => guided('onb.q1.next').click());
        await answer(2);
        await expectStep('q2_next');
        act(() => guided('onb.q2.next').click());
        await answer(3);
        await expectStep('q3_lock');
        guideNext();
        await expectStep('q3_complete');
        act(() => guided('onb.q3.next').click());

        await expectStep('done');
        act(() => within(callout()!).getByRole('button', { name: 'Got it' }).click());
        expect(onDismiss).toHaveBeenCalledWith('completed');
        expect(engine.state.lifecycle).toBe('ready');
    });

    it('counts the steps that apply now: no Other box, no "Did you mean…?" on the straight path', async () => {
        renderGuided(at('legal.review'));
        await start();
        await expectStep('terms');
        // terms, name, location, continue, trade, continue, 3 work groups, continue,
        // q1 lock + answer + next, q2 answer + next, q3 answer + lock + complete, summary.
        expect(callout()!.textContent).toContain('Your profile · 1 of 19');
    });
});

describe('W1 guide: trade', () => {
    it('opens the Other step only when Other is picked, and asks for 2 to 60 characters', async () => {
        renderGuided(at('profile.trade'));
        await start();
        await expectStep('trade');
        press('onb.trade.list', 'Other');

        await expectStep('trade_other');
        const box = within(guided('onb.trade.other')).getByRole('textbox');
        // It does not take the focus by itself: the guide points at it.
        expect(document.activeElement).not.toBe(box);
        type(box, 'w');
        expect(guideNextDisabled()).toBe(true);
        type(box, '   w   ');
        expect(guideNextDisabled()).toBe(true);
        type(box, 'x'.repeat(61));
        expect(guideNextDisabled()).toBe(true);
        type(box, 'x'.repeat(60));
        expect(guideNextDisabled()).toBe(false);
        type(box, 'Welder');
        guideNext();

        await expectStep('trade_continue');
        act(() => guided('onb.trade.continue').click());
        await expectStep('years');
        expect(engine.state.profile.trade).toEqual({ key: 'other', other: 'Welder' });
    });

    it('skips the Other step for a standard trade', async () => {
        renderGuided(at('profile.trade'));
        await start();
        await expectStep('trade');
        press('onb.trade.list', 'Plumber');
        await expectStep('trade_continue');
        expect(document.querySelector('[data-guide="onb.trade.other"]')).toBeNull();
    });

    it('sends a run parked on a typed trade through Back before a standard trade', async () => {
        renderGuided(at('profile.custom_trade', {
            profile: { ...at('legal.review').profile, trade: { key: 'other', other: 'Welder' } as never },
        }));
        await start();
        await expectStep('trade');
        // Already answered (Other, on WhatsApp): the step offers Next rather
        // than moving on by itself.
        press('onb.trade.list', 'Carpenter');
        guideNext();
        await expectStep('trade_back');
        // The title names the gesture of this input, as the bodies do (a mouse here).
        expect(callout()?.querySelector('h2')).toHaveTextContent('Click Back first');
        expect(guided('onb.trade.continue')).toBeDisabled();

        act(() => guided('onb.trade.back').click());
        await flush();
        expect(api.postOnboardingBack).toHaveBeenCalledTimes(1);
        press('onb.trade.list', 'Carpenter');
        act(() => guided('onb.trade.continue').click());
        await expectStep('years');
    });
});

describe('W1 guide: about you', () => {
    it('does not count a city that was typed but not picked, and moves on once one is picked', async () => {
        renderGuided(at('profile.name'));
        await start();
        await expectStep('name');
        const [first, last] = within(guided('onb.about.name')).getAllByRole('textbox');
        type(first, 'Ana');
        expect(guideNextDisabled()).toBe(true);
        type(last, 'Lopez');
        guideNext();

        await expectStep('location');
        const box = within(guided('onb.about.location')).getByRole('combobox');
        act(() => box.focus());
        type(box, 'El Paso');
        await flush(200);
        fireEvent.blur(box);
        // Still on the step, and the page says why.
        expect(stepNow()).toBe('location');
        expect(screen.getByText(en.worker_onboarding.about.location_pick)).toBeInTheDocument();
        expect(within(callout()!).getByText(en.tutorial.worker_onboarding.guide.steps.location.wait)).toBeInTheDocument();

        await pickElPaso();
        await expectStep('about_continue');
    });

    it('takes a typed 5-digit ZIP as the location', async () => {
        renderGuided(at('profile.location', { profile: { ...at('legal.review').profile, fullName: 'Ana Lopez' } }));
        await start();
        await expectStep('name');
        guideNext();
        await expectStep('location');
        type(within(guided('onb.about.location')).getByRole('combobox'), '79901');
        await expectStep('about_continue');
    });

    it('asks "Did you mean…?" and, on Yes, goes on to the trade', async () => {
        renderGuided(at('profile.name'));
        engine.confirmNext = true;
        await start();
        await throughAbout();
        await expectStep('location_confirm');
        act(() => within(guided('onb.about.confirm')).getByRole('button', { name: "Yes, that's right" }).click());
        await expectStep('trade');
    });

    it('on No to "Did you mean…?", stays with the worker while they pick again and Continue', async () => {
        renderGuided(at('profile.name'));
        engine.confirmNext = true;
        await start();
        await throughAbout();
        await expectStep('location_confirm');
        act(() => within(guided('onb.about.confirm')).getByRole('button', { name: 'No, let me change it' }).click());
        await vi.waitFor(() => expect(document.querySelector('[data-guide="onb.about.confirm"]')).toBeNull());
        expect(stepNow()).toBe('location_confirm');
        await pickElPaso();
        act(() => guided('onb.about.continue').click());
        await expectStep('trade');
    });

    it('keeps the Continue step up when the save fails, and goes on after a retry', async () => {
        renderGuided(at('profile.name'));
        engine.failNext = true;
        await start();
        await throughAbout();
        await flush(50);
        expect(stepNow()).toBe('about_continue');
        expect(screen.getByText(en.common.errors.offline)).toBeInTheDocument();
        act(() => guided('onb.about.continue').click());
        await expectStep('trade');
    });
});

describe('W1 guide: work', () => {
    it('takes No for transportation as an answer', async () => {
        renderGuided(at('profile.experience'));
        await start();
        await throughWork();
        await expectStep('q1_lock');
        expect(engine.state.profile.hasTransportation).toBe(false);
    });
});

describe('W1 guide: the three questions', () => {
    it('says on question 1 that answers can change until question 3', async () => {
        renderGuided(at('trust.question.1'));
        await start();
        await expectStep('q1_lock');
        expect(within(callout()!).getByText(en.tutorial.worker_onboarding.guide.steps.q1_lock.body)).toBeInTheDocument();
    });

    it('needs at least 15 characters, and no more than 2000', async () => {
        renderGuided(at('trust.question.2'));
        await start();
        await expectStep('q2_answer');
        const box = within(guided('onb.q2.answer')).getByRole('textbox');
        type(box, '12345678901234');
        expect(guideNextDisabled()).toBe(true);
        type(box, `   ${'a'.repeat(14)}   `);
        expect(guideNextDisabled()).toBe(true);
        type(box, '123456789012345');
        expect(guideNextDisabled()).toBe(false);
        type(box, 'a'.repeat(2001));
        expect(guideNextDisabled()).toBe(true);
    });

    it('does not mention the microphone where this browser cannot record', async () => {
        renderGuided(at('trust.question.1'));
        await start();
        await expectStep('q1_lock');
        guideNext();
        await expectStep('q1_answer');
        expect(guided('onb.q1.answer')).toHaveAttribute('data-mic', 'off');
    });

    it('offers the microphone where it can record, and waits for a recording to be written down', async () => {
        vi.stubGlobal('MediaRecorder', class {
            static isTypeSupported() { return true; }
            ondataavailable: ((event: { data: Blob }) => void) | null = null;
            onstop: (() => void) | null = null;
            start() {}
            stop() {}
        });
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) },
        });
        renderGuided(at('trust.question.2'));
        await start();
        await expectStep('q2_answer_voice');
        expect(within(callout()!).getByText(/microphone/)).toBeInTheDocument();

        const block = guided('onb.q2.answer');
        type(within(block).getByRole('textbox'), 'I know saws, drills and levels well.');
        expect(guideNextDisabled()).toBe(false);
        await act(async () => {
            within(block).getByRole('button', { name: en.worker_onboarding.trust.voice.start }).click();
        });
        await vi.waitFor(() => expect(block).toHaveAttribute('data-voice-phase', 'recording'));
        expect(guideNextDisabled()).toBe(true);
    });

    it('says on question 3 that the answers lock, and completes on the summary', async () => {
        const { onDismiss } = renderGuided(at('trust.question.3', {
            trust: {
                questions: THREE_QUESTIONS,
                answers: [
                    { index: 1, text: 'I finish slabs and driveways.', source: 'text' },
                    { index: 2, text: 'Floats, edgers and screeds.', source: 'text' },
                ] as never,
            },
        }));
        await start();
        await answer(3);
        await expectStep('q3_lock');
        expect(within(callout()!).getByText(/Complete your questions/)).toBeInTheDocument();
        guideNext();
        await expectStep('q3_complete');
        act(() => guided('onb.q3.next').click());
        await expectStep('done');
        expect(onDismiss).not.toHaveBeenCalled();
    });
});

describe('W1 guide: server state', () => {
    it('starts a resumed run at the screen the server is on', async () => {
        renderGuided(at('trust.question.2'));
        await start();
        await expectStep('q2_answer');
    });

    it('skips the screens another device answered while the guide was up', async () => {
        renderGuided(at('profile.trade'));
        await start();
        await expectStep('trade');
        // WhatsApp answered the trade and the work screen meanwhile: this tab's
        // next save is told it is behind, re-reads, and lands on question 1.
        engine.state.run.stepKey = 'trust.question.1';
        api.postOnboardingAnswers.mockImplementationOnce(async () => ({ kind: 'step_mismatch' }));
        press('onb.trade.list', 'Painting');
        await expectStep('trade_continue');
        act(() => guided('onb.trade.continue').click());
        await expectStep('q1_lock');
    });

    it('has nothing to show over an exit panel', async () => {
        const { onUnavailable } = renderGuided(at('profile.photo'));
        await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalled());
        expect(callout()).toBeNull();
    });

    it('speaks Spanish with tú', async () => {
        renderGuided(at('legal.review'), 'es');
        const intro = await screen.findByRole('dialog', { name: es.tutorial.worker_onboarding.guide.intro_title });
        act(() => within(intro).getByRole('button', { name: es.tutorial.common.guide.worker.start }).click());
        await expectStep('terms');
        expect(within(callout()!).getAllByText(/Acepto y continúo/).length).toBeGreaterThan(0);
        expect(es.tutorial.worker_onboarding.guide.steps.name.body).toMatch(/^Escribe/);
    });
});
