import { MAX_ANSWER_CHARS, MIN_ANSWER_CHARS, customTradeAcceptable } from '@/lib/onboarding-flow';
import { guideTarget } from '../spotlight/steps';
import type { SpotlightStep } from '../spotlight/steps';
import { fieldIn } from './dom';
import type { WalkthroughGuide } from './types';

/**
 * W1's step-by-step guide: creating the worker profile, on the onboarding
 * page (no dialog). It replaces the slides that used to open on the terms
 * screen; Help keeps the slides as the overview.
 *
 * The screens, in the server's order: terms, about you, trade, work (three
 * groups on one screen), questions 1 to 3, then the summary. The address never
 * changes between them; `onb.screen` carries the screen as `data-screen`.
 *
 * HOW THE STEPS FOLLOW THE SCREENS. Every control has a name of its own per
 * screen (`onb.about.continue`, `onb.q2.next`), and every step applies only
 * until its screen has been passed (`notPassed`). So:
 *  - a Continue step completes when its screen gives way to the next one (not
 *    on the click: the save may fail and leave the screen up, with its error);
 *  - a guide started on a later screen starts at the screen on show;
 *  - if the run moves on elsewhere (an answer on WhatsApp), the steps of the
 *    screens left behind are skipped.
 *
 * Branches: Other opens the typed-trade box (2 to 60 characters, it does not
 * take focus by itself); a run parked on the typed trade with a standard trade
 * picked can only go on through Back; the "Did you mean…?" box replaces
 * Continue, and "No" leaves the worker on About you to pick again (that step
 * opens the whole screen and lasts until it gives way); the answer
 * step mentions the microphone only where this browser can record, and waits
 * for a recording to be written down before it counts the answer; question 1
 * says the answers can change until question 3, and question 3 says they lock.
 */

const KEY = 'tutorial.worker_onboarding.guide';

const SCREENS = ['terms', 'about', 'trade', 'work', 'q1', 'q2', 'q3', 'done'] as const;
type Screen = (typeof SCREENS)[number];

function copy(id: string) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
        waitKey: `${KEY}.steps.${id}.wait`,
    };
}

/** The screen on show, as the flow marks it; null on an exit panel or before the flow is up. */
export function screenNow(): Screen | null {
    const screen = guideTarget('onb.screen')?.getAttribute('data-screen') ?? null;
    return (SCREENS as readonly string[]).includes(screen ?? '') ? (screen as Screen) : null;
}

function on(screen: Screen): boolean {
    return screenNow() === screen;
}

/** `screen` is on show or still ahead. */
function notPassed(screen: Screen): boolean {
    const now = screenNow();
    return now !== null && SCREENS.indexOf(now) <= SCREENS.indexOf(screen);
}

function confirmShown(): boolean {
    return guideTarget('onb.about.confirm') !== null;
}

/** Continue on the trade screen is described by the "tap Back first" hint only while that hint shows. */
function switchHintShown(): boolean {
    return guideTarget('onb.trade.continue')?.hasAttribute('aria-describedby') ?? false;
}

function pressed(control: Element): boolean {
    return control.querySelector('[aria-pressed="true"]') !== null;
}

function micOn(question: 1 | 2 | 3): boolean {
    return guideTarget(`onb.q${question}.answer`)?.getAttribute('data-mic') === 'on';
}

/** Both name boxes hold something other than spaces. */
function namesFilled(control: Element): boolean {
    const boxes = Array.from(control.querySelectorAll('input'));
    return boxes.length > 0 && boxes.every((box) => box.value.trim() !== '');
}

/** The box holds 15 to 2000 characters (trimmed), and no recording is still on its way into it. */
function answerReady(control: Element): boolean {
    const length = control.querySelector('textarea')?.value.trim().length ?? 0;
    const idle = (control.getAttribute('data-voice-phase') ?? 'idle') === 'idle';
    return idle && length >= MIN_ANSWER_CHARS && length <= MAX_ANSWER_CHARS;
}

function continueStep(id: string, screen: Screen, target: string, extra: Partial<SpotlightStep> = {}): SpotlightStep {
    return {
        id,
        target: { guide: target },
        mode: 'action',
        placement: 'top',
        when: () => notPassed(screen),
        // The screen giving way, not the click: a save that fails leaves it up.
        advanceWhen: () => !on(screen),
        ...copy(id),
        ...extra,
    };
}

function questionSteps(question: 1 | 2 | 3): SpotlightStep[] {
    const screen = `q${question}` as Screen;
    const answer = (id: string, mic: boolean): SpotlightStep => ({
        id,
        target: { guide: `onb.q${question}.answer` },
        mode: 'next',
        when: () => notPassed(screen) && micOn(question) === mic,
        ready: answerReady,
        ...copy(mic ? `answer_voice` : `answer`),
    });
    const steps: SpotlightStep[] = [];
    if (question === 1) {
        steps.push({ id: 'q1_lock', target: { guide: 'onb.q1.lock' }, mode: 'next', when: () => notPassed('q1'), ...copy('q1_lock') });
    }
    steps.push(answer(`q${question}_answer_voice`, true), answer(`q${question}_answer`, false));
    if (question === 3) {
        steps.push({ id: 'q3_lock', target: { guide: 'onb.q3.lock' }, mode: 'next', when: () => notPassed('q3'), ...copy('q3_lock') });
        steps.push(continueStep('q3_complete', 'q3', 'onb.q3.next'));
    } else {
        steps.push(continueStep(`q${question}_next`, screen, `onb.q${question}.next`, copy('question_next')));
    }
    return steps;
}

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.worker_onboarding.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: [
        continueStep('terms', 'terms', 'onb.terms.accept'),
        {
            id: 'name',
            target: { guide: 'onb.about.name' },
            mode: 'next',
            when: () => notPassed('about'),
            ready: namesFilled,
            ...copy('name'),
        },
        {
            id: 'location',
            target: { guide: 'onb.about.location' },
            mode: 'auto',
            // Above the box, so the suggestion list opening below it stays clear.
            placement: 'top',
            when: () => notPassed('about') && !confirmShown(),
            // A picked city or a 5-digit ZIP; typed text that is not a place does not count.
            advanceWhen: (control) => control.hasAttribute('data-resolved'),
            ...copy('location'),
        },
        continueStep('about_continue', 'about', 'onb.about.continue', {
            when: () => notPassed('about') && !confirmShown(),
            // The "Did you mean…?" box takes Continue's place.
            advanceWhen: () => !on('about') || confirmShown(),
            ...copy('about_continue'),
        }),
        // "Did you mean…?" takes Continue's place. Yes goes on; No leaves the
        // worker on About you to pick the place again and Continue again, so
        // the whole screen is open for this step, until it gives way.
        {
            id: 'location_confirm',
            target: { guide: 'onb.screen' },
            mode: 'action',
            when: () => on('about') && confirmShown(),
            advanceWhen: () => !on('about'),
            ...copy('location_confirm'),
        },
        {
            id: 'trade',
            target: { guide: 'onb.trade.list' },
            mode: 'auto',
            when: () => notPassed('trade'),
            advanceWhen: pressed,
            ...copy('trade'),
        },
        {
            id: 'trade_other',
            target: { guide: 'onb.trade.other' },
            mode: 'next',
            // The box is there only while Other is the picked trade.
            when: () => notPassed('trade') && guideTarget('onb.trade.other') !== null,
            ready: (control) => customTradeAcceptable(fieldIn(control)?.value ?? ''),
            ...copy('trade_other'),
        },
        // A run that is waiting for a typed trade (Other was picked on
        // WhatsApp) cannot take a standard trade from here: Back first. The
        // whole screen is open for this one, Back, the list and Continue.
        {
            id: 'trade_back',
            target: { guide: 'onb.screen' },
            mode: 'action',
            when: () => on('trade') && switchHintShown(),
            advanceWhen: () => !on('trade'),
            ...copy('trade_back'),
        },
        continueStep('trade_continue', 'trade', 'onb.trade.continue'),
        { id: 'years', target: { guide: 'onb.work.years' }, mode: 'auto', when: () => notPassed('work'), advanceWhen: pressed, ...copy('years') },
        {
            id: 'transport',
            target: { guide: 'onb.work.transport' },
            mode: 'auto',
            when: () => notPassed('work'),
            // "No" is an answer too.
            advanceWhen: pressed,
            ...copy('transport'),
        },
        {
            id: 'availability',
            target: { guide: 'onb.work.availability' },
            mode: 'auto',
            when: () => notPassed('work'),
            advanceWhen: pressed,
            ...copy('availability'),
        },
        continueStep('work_continue', 'work', 'onb.work.continue'),
        ...questionSteps(1),
        ...questionSteps(2),
        ...questionSteps(3),
        {
            id: 'done',
            target: { guide: 'onb.done.profile' },
            mode: 'next',
            when: () => notPassed('done'),
            ...copy('done'),
        },
    ],
};

export default guide;
