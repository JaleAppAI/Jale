import { guideSelector, guideTarget, isRendered } from '../spotlight/steps';
import type { SpotlightStep } from '../spotlight/steps';
import type { WalkthroughGuide } from './types';

/**
 * E4's step-by-step guide: messages. It plays once the conversation is open
 * (`runWithHost`): a row picked on the Conversations page, or the drawer
 * opened from its launcher or an applicant's Message button.
 *
 * The thread and the first-message composer are the same components in both
 * places, so their marks (`msg.*`) are the same; while the drawer is open the
 * guide looks inside it first, so it never points at the page behind.
 *
 * What it says about delivery is the app's static copy, not a live check:
 * the frontend does not know whether the 24-hour reply window is open, so
 * the guide explains the rule and the status words under each message.
 */

const KEY = 'tutorial.employer_messages.guide';

/** Every step here is always ready (nothing to wait for), so none has a wait line. */
function keys(id: string) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
    };
}

/** The open drawer, if it is. */
const drawer = () => guideTarget('msg.drawer');
const drawerOpen = () => drawer() !== null;

/** The first rendered `msg.<name>` in the open drawer, else on the page. */
function inScope(name: string): HTMLElement | null {
    const root: ParentNode = drawer() ?? document;
    return Array.from(root.querySelectorAll<HTMLElement>(guideSelector(name))).find(isRendered) ?? null;
}

/** A conversation (or a new applicant's composer) is open in the pane. */
const threadOpen = () => has('msg.first') || has('msg.transcript');

const has = (name: string) => inScope(name) !== null;
const target = (name: string) => () => inScope(name);

const STEPS: readonly SpotlightStep[] = [
    {
        id: 'list',
        // The drawer opened from its launcher, with nothing picked yet. The
        // first conversation in the list (the list itself when it is empty):
        // on a phone the list fills the drawer, and a callout beside a target
        // that tall would have to cover it.
        target: () => {
            const list = inScope('msg.list');
            return Array.from(list?.querySelectorAll<HTMLElement>('li') ?? []).find(isRendered) ?? list;
        },
        when: () => drawerOpen() && !threadOpen(),
        mode: 'next',
        ...keys('list'),
    },
    {
        id: 'first',
        target: target('msg.first'),
        when: () => has('msg.first'),
        mode: 'next',
        ...keys('first'),
    },
    {
        id: 'thread',
        // The newest message (the transcript itself while it is empty): the
        // transcript fills the pane, and a callout beside it would cover it.
        target: () => {
            const transcript = inScope('msg.transcript');
            return (transcript?.lastElementChild as HTMLElement | null) ?? transcript;
        },
        when: () => has('msg.transcript'),
        mode: 'next',
        ...keys('thread'),
    },
    {
        id: 'window',
        // The Conversations page's caption: the whole of the reply-window rule on screen.
        target: target('msg.caption'),
        when: () => has('msg.caption') && !drawerOpen(),
        mode: 'next',
        ...keys('window'),
    },
    {
        id: 'write',
        target: target('msg.input'),
        when: () => has('msg.input'),
        mode: 'next',
        placement: 'top',
        ...keys('write'),
    },
    {
        id: 'send',
        target: target('msg.send'),
        when: () => has('msg.send'),
        mode: 'next',
        placement: 'top',
        ...keys('send'),
    },
    {
        id: 'closed',
        target: target('msg.closed'),
        when: () => has('msg.closed'),
        mode: 'next',
        placement: 'top',
        ...keys('closed'),
    },
    {
        id: 'not_interested',
        // The Conversations page only: the drawer has no Not interested.
        target: target('msg.not_interested'),
        when: () => has('msg.not_interested'),
        mode: 'next',
        ...keys('not_interested'),
    },
    {
        id: 'close',
        target: target('msg.close'),
        when: () => has('msg.close'),
        mode: 'next',
        ...keys('close'),
    },
    {
        id: 'put_away',
        // On a phone the drawer's own Hide; otherwise the launcher, which reads Close.
        target: () => inScope('msg.hide') ?? Array.from(document.querySelectorAll<HTMLElement>(guideSelector('msg.launcher'))).find(isRendered) ?? null,
        when: drawerOpen,
        mode: 'next',
        // Said, not pressed: putting the drawer away would take the guide's page with it.
        interactive: false,
        placement: 'top',
        ...keys('put_away'),
    },
];

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.employer_messages.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: STEPS,
};

export default guide;
